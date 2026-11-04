import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startBillingPostgresFixture, type BillingPostgresFixture } from "../helpers/billing-postgres";
import { getMerchantPromotionPage, selectPromotionOffer } from "../../app/services/promotions/promotion.service";

const suffix = randomUUID();
const shopId = `shop-${suffix}`, planId = `plan-${suffix}`, adminId = `admin-${suffix}`;
const campaignAId = `campaign-a-${suffix}`, campaignBId = `campaign-b-${suffix}`;
const now = new Date("2026-09-13T12:00:00Z");

function twoReaders() {
  let count = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  return async () => { if (++count === 2) release(); await both; };
}
// Both first transactions finish the real selection read before either writes.
function racingConnection(client: PrismaClient, wait: () => Promise<void>): PrismaClient {
  let synchronized = false;
  return new Proxy(client, { get(target, key) {
    if (key === "$transaction") return (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
      target.$transaction(tx => operation(new Proxy(tx, { get(connection, model) {
        if (model === "merchantPromotionSelection") return new Proxy(connection.merchantPromotionSelection, { get(delegate, method) {
          if (method === "findUnique") return async (query: Parameters<typeof delegate.findUnique>[0]) => {
            const row = await delegate.findUnique(query);
            if (!synchronized) { synchronized = true; await wait(); }
            return row;
          };
          const value = Reflect.get(delegate, method); return typeof value === "function" ? value.bind(delegate) : value;
        } });
        const value = Reflect.get(connection, model); return typeof value === "function" ? value.bind(connection) : value;
      } })), { ...options, timeout: 30_000 });
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
}

describe.skipIf(process.env.MODA_DISPOSABLE_INTEGRATION !== "1")("promotion selection and translated pages on migrated PG17", () => {
  let fixture: BillingPostgresFixture;
  let database: PrismaClient;
  const queries: string[] = [];
  beforeAll(async () => {
    fixture = await startBillingPostgresFixture(); database = fixture.database;
    fixture.database.$on("query", event => { queries.push(event.query); });
    await database.platformAdmin.create({ data: { id: adminId, email: `${adminId}@example.test`, role: "SUPER_ADMIN", active: true } });
    await database.billingPlan.create({ data: { id: planId, shopifyPlanHandle: planId, name: "Promotion test", kind: "PAID_METERED", active: true,
      shopifyUsageEventHandle: "message-meter", includedRecoveryConversationAllowance: 100 } });
    await database.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
    await database.subscription.create({ data: { shopId, planId, status: "ACTIVE", observedShopifyPlanHandle: planId } });
    await database.promotionCampaign.createMany({ data: [campaignAId, campaignBId].map((id, index) => ({
      id, name: `Campaign ${index}`, merchantDescription: "Test", scope: "GLOBAL" as const, quantity: index ? 40 : 25,
      startsAt: new Date("2026-09-01"), expiresAt: new Date("2026-10-01"), status: "ACTIVE" as const, createdByPlatformAdminId: adminId,
    })) });
  }, 240_000);
  beforeEach(async () => {
    await database.merchantPromotionSelection.deleteMany({ where: { shopId } });
    await database.promotionalCreditGrant.deleteMany({ where: { shopId } });
  });
  afterAll(async () => {
    process.stdout.write(JSON.stringify({ suite: "promotion_postgres", emittedSql: queries.length }) + "\n");
    await fixture?.cleanup();
  }, 60_000);

  it.each([false, true])("commits one selection and one normal locked denial with same campaign=%s", async same => {
    const wait = twoReaders();
    const one = fixture.createClient("promotion-first"), two = fixture.createClient("promotion-second");
    one.$on("query", event => { queries.push(event.query); }); two.$on("query", event => { queries.push(event.query); });
    let sinkCalls = 0;
    const diagnostics = same ? createLogger({ serviceName: "moda-interact", environment: "test", sink: () => {
      sinkCalls++; throw new Error("isolated sink failure");
    } }) : undefined;
    const outcomes = await Promise.allSettled([
      selectPromotionOffer(shopId, campaignAId, now, racingConnection(one, wait), diagnostics),
      selectPromotionOffer(shopId, same ? campaignAId : campaignBId, now, racingConnection(two, wait), diagnostics),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    if (same) expect(sinkCalls).toBeGreaterThanOrEqual(1);
    const denied = outcomes.find(outcome => outcome.status === "rejected");
    expect(denied).toMatchObject({ reason: { code: "ACTIVE_PROMOTION_ALREADY_SELECTED" } });
    const grants = await database.promotionalCreditGrant.findMany({ where: { shopId } });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ shopId, selectionCount: 1, committedQuantity: 0, reservedQuantity: 0 });
    if (same) expect(grants[0]).toMatchObject({ campaignId: campaignAId, quantity: 25 });
    else expect([25, 40]).toContain(grants[0].quantity);
    const selections = await database.merchantPromotionSelection.findMany({ where: { shopId } });
    expect(selections).toHaveLength(1); expect(selections[0].promotionalCreditGrantId).toBe(grants[0].id);
  }, 30_000);

  it("counts exactly translated/targeted offers and pages tied rows with bounded SQL", async () => {
    const foreignShopId = `other-${suffix}`;
    await database.shop.create({ data: { id: foreignShopId, domain: `${foreignShopId}.test`, status: "ACTIVE" } });
    const expected: string[] = [];
    for (let index = 0; index < 23; index++) {
      const id = `offer-${String(index).padStart(2, "0")}-${suffix}`;
      const locale = index % 4 === 0 ? "fr" : "en";
      const scope = index === 21 ? "SHOP" : index % 3 === 1 ? "PLAN" : index % 3 === 2 ? "SHOP" : "GLOBAL";
      if (locale === "en" && index !== 21) expected.push(id);
      await database.promotionCampaign.create({ data: {
        id, name: `Campaign ${index}`, merchantDescription: "Details", scope,
        targetPlanId: scope === "PLAN" ? planId : null, targetShopId: scope === "SHOP" ? index === 21 ? foreignShopId : shopId : null,
        quantity: 10, startsAt: new Date("2026-09-01"), expiresAt: new Date("2026-10-01"), createdAt: new Date("2026-09-01"),
        status: "ACTIVE", createdByPlatformAdminId: adminId,
        translations: { create: { locale, merchantTitle: `Translated ${index}`, merchantDescription: "Details" } },
      } });
    }
    const input = { shopId, shopStatus: "ACTIVE", subscriptionStatus: "ACTIVE", planId, locale: "en", now, historyPage: 1 };
    const selected: string[] = [];
    for (let offerPage = 1; offerPage <= 3; offerPage++) {
      const offset = queries.length;
      const page = await getMerchantPromotionPage({ ...input, offerPage }, database);
      expect(page.offersPagination).toMatchObject({ totalEntries: expected.length, totalPages: 3, page: offerPage, pageSize: 6 });
      expect(page.offers).toHaveLength(offerPage === 3 ? expected.length - 12 : 6);
      expect(page.offers.every(offer => offer.merchantTitle?.startsWith("Translated"))).toBe(true);
      selected.push(...page.offers.map(offer => offer.id));
      const sql = queries.slice(offset);
      expect(sql.filter(query => query.startsWith("SELECT")).length).toBeGreaterThanOrEqual(5);
      process.stdout.write(JSON.stringify({ operation: "translated_promotion_page", page: offerPage, returnedRows: page.offers.length,
        totalEntries: page.offersPagination.totalEntries, emittedSql: sql.length,
        selectStatements: sql.filter(query => /^SELECT\b/i.test(query)).length,
        transactionControl: sql.filter(query => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(query)).length }) + "\n");
    }
    expect(selected).toEqual(expected.sort());
    expect(new Set(selected).size).toBe(expected.length);
    const clamped = await getMerchantPromotionPage({ ...input, offerPage: 999 }, database);
    expect(clamped.offersPagination.page).toBe(3);
    expect(clamped.offers.map(offer => offer.id)).toEqual(expected.slice(12));
  }, 30_000);
});
