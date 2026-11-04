import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";

import { RecoveryCreditPurchaseManagementService } from "../../app/services/billing/recovery-credit-purchase-management.service";
import { ShopifyBillingProvider } from "../../app/services/billing/providers/shopify-billing.provider";
import { createShopifyPlatformConfigurationService } from "../../app/services/platform-configuration/service.server";
import { platformConfigurationAAD } from "../../app/services/platform-configuration/seal.server";

const start = new Date("2026-09-01T00:00:00Z");
const end = new Date("2026-10-01T00:00:00Z");
const providerBody = {
  data: { activeSubscription: {
    billingPeriod: "EVERY_30_DAYS", cancelAtEndOfCycle: false, trialEndsAt: null,
    currentBillingCycle: { startTime: start.toISOString(), endTime: end.toISOString() },
    items: [
      { handle: "growth", description: null,
        price: { __typename: "FlatRatePrice", active: true, currency: "USD", amount: "19.00" }, usage: null },
      { handle: "pack", description: null,
        price: { __typename: "TieredPrice", active: true, currency: "USD", tiersMode: "VOLUME",
          tiers: [{ upTo: null, amountPerUnit: "5.00", amount: "0.00" }] }, usage: null },
    ],
    pendingUpdate: null, legacySubscriptionId: "provider-1",
  } },
};
type Refund = {
  id: string; provider: string; status: "COMPLETED" | "CANCELLED"; reason: string;
  finalCreditQuantity: number; expectedProviderAmount: string; expectedProviderCurrency: string;
  createdAt: Date; completedAt: Date | null; providerActionKind: null;
};
type Relation = { where?: { provider?: string; status?: string }; take?: number; orderBy?: unknown };
type Read = {
  where: { shopId: string; provider: string; status?: string; id?: { in: string[] } };
  skip?: number; take?: number; select?: { refunds: Relation }; include?: { refunds: Relation };
};

function historyFixture(count: number, eligible = true, refunds: Refund[] = []) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `purchase-${index}`, shopId: "shop-1", provider: "SHOPIFY", status: "ACTIVE",
    createdAt: start, activatedAt: start, creditsGranted: 5, currentAmount: 5, reservedAmount: 0,
    version: 0, billingPeriodId: "period-1", shopifyPlanHandleSnapshot: "growth",
    shopifyEventHandleSnapshot: "pack", providerSubscriptionIdSnapshot: deriveShopifyProviderContextIdentity({
      providerSubscriptionId: "provider-1", planHandle: "growth", currentPeriodStart: start, currentPeriodEnd: end,
    }),
    providerPurchaseAmount: eligible ? "5.00" : "0.00", providerPurchaseCurrency: "USD",
    plan: { name: "Growth", shopifyPlanHandle: "growth" }, refunds: index === 0 ? refunds : [],
  }));
  const keyring = parseCredentialKeyring(JSON.stringify({ "fixture-root": randomBytes(32).toString("base64") }));
  const envelope = encryptCredential({
    keyring, activeKeyId: "fixture-root",
    plaintext: JSON.stringify({ accessToken: "fixture-partner-token", organizationId: "org_1", appId: "app_1", apiVersion: "2026-10" }),
    aad: platformConfigurationAAD("test", "shopify.partner", 1),
  });
  const configurationRead = vi.fn(async () => ({
    environment: "test", key: "shopify.partner", version: 1,
    value: { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: envelope.keyId,
      nonce: Buffer.from(envelope.nonce).toString("base64"),
      ciphertext: Buffer.from(envelope.ciphertext).toString("base64"),
      authTag: Buffer.from(envelope.authTag).toString("base64") },
  }));
  const configuration = createShopifyPlatformConfigurationService({
    database: { platformConfiguration: { findUnique: configurationRead } },
    environment: "test", loadUnsealKeyring: () => keyring,
  });
  const countRead = vi.fn(async () => count);
  const pageRead = vi.fn(async (query: Read) => {
    const selected = rows.filter(row => !query.where.id || query.where.id.in.includes(row.id));
    const relation = query.select?.refunds ?? query.include?.refunds;
    const page = query.select ? [...selected].reverse() : selected.slice(query.skip ?? 0, (query.skip ?? 0) + (query.take ?? count));
    return page.map(row => ({
      ...row,
      refunds: [...row.refunds]
        .filter(refund => !relation?.where?.status || refund.status === relation.where.status)
        .filter(refund => !relation?.where?.provider || refund.provider === relation.where.provider)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
        .slice(0, relation?.take ?? row.refunds.length),
    }));
  });
  const shopRead = vi.fn(async () => ({
    id: "shop-1", shopifyShopId: "gid://shopify/Shop/1", status: "ACTIVE", platform: "SHOPIFY",
  }));
  const subscriptionRead = vi.fn(async () => ({
    shopId: "shop-1", billingPeriodId: "period-1", billingPeriod: { id: "period-1", periodStart: start, periodEnd: end },
  }));
  const database = {
    recoveryCreditPurchase: { count: countRead, findMany: pageRead },
    shop: { findUnique: shopRead }, subscription: { findUnique: subscriptionRead },
  };
  const fetch = vi.fn(async () => Response.json(providerBody));
  vi.stubGlobal("fetch", fetch);
  return {
    service: new RecoveryCreditPurchaseManagementService(database as never, new ShopifyBillingProvider(configuration)),
    repositoryCalls: () => countRead.mock.calls.length + pageRead.mock.calls.length +
      shopRead.mock.calls.length + subscriptionRead.mock.calls.length + configurationRead.mock.calls.length,
    fetch, pageRead, shopRead, subscriptionRead, configurationRead,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("recovery credit history method budget", () => {
  it.each([1, 5, 20])("uses six repository methods and one Partner request for %i eligible rows", async count => {
    const fixture = historyFixture(count);
    const result = await fixture.service.listPurchaseHistory({
      shopId: "shop-1", shopifyShopId: "gid://shopify/Shop/1", pageSize: count,
    });
    process.stdout.write(JSON.stringify({ operation: "eligible_history", rows: count,
      repositoryMethods: fixture.repositoryCalls(), providerRequests: fixture.fetch.mock.calls.length }) + "\n");
    expect(result.purchases).toHaveLength(count);
    expect(result.purchases.every(row => row.refundEligible)).toBe(true);
    expect(fixture.repositoryCalls()).toBe(6);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.configurationRead).toHaveBeenCalledOnce();
    expect(fixture.pageRead).toHaveBeenNthCalledWith(1, expect.objectContaining({
      include: expect.objectContaining({ refunds: expect.objectContaining({
        take: 1, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }) }),
    }));
    expect(fixture.pageRead).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { shopId: "shop-1", provider: "SHOPIFY", id: { in: result.purchases.map(row => row.id) } },
      select: { id: true, refunds: expect.objectContaining({
        take: 1, where: { provider: "SHOPIFY", status: "COMPLETED" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }) },
    }));
  });

  it("uses three methods without credentials/provider verification for zero-value rows", async () => {
    const fixture = historyFixture(20, false);
    const result = await fixture.service.listPurchaseHistory({ shopId: "shop-1", shopifyShopId: "gid://shopify/Shop/1" });
    expect(result.purchases.every(row => row.refundUnavailableReason === "ZERO_VALUE")).toBe(true);
    expect(fixture.repositoryCalls()).toBe(3);
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.configurationRead).not.toHaveBeenCalled();
  });

  it("uses two methods for an empty page and one extra method for a clamp", async () => {
    const empty = historyFixture(0);
    await empty.service.listPurchaseHistory({ shopId: "shop-1" });
    expect(empty.repositoryCalls()).toBe(2);
    const clamped = historyFixture(5);
    const result = await clamped.service.listPurchaseHistory({
      shopId: "shop-1", shopifyShopId: "gid://shopify/Shop/1", page: 999, pageSize: 5,
    });
    expect(result.page).toBe(1);
    expect(clamped.repositoryCalls()).toBe(7);
    expect(clamped.fetch).toHaveBeenCalledOnce();
  });

  it("retains an older completed refund behind newer cancellations, with deterministic equal-time ordering", async () => {
    const base = { provider: "SHOPIFY", finalCreditQuantity: 2, expectedProviderAmount: "2.00",
      expectedProviderCurrency: "USD", providerActionKind: null };
    const refunds: Refund[] = [
      { ...base, id: "completed-a", status: "COMPLETED", reason: "older-a", createdAt: start, completedAt: start },
      { ...base, id: "completed-z", status: "COMPLETED", reason: "older-z", createdAt: start, completedAt: start },
      ...Array.from({ length: 50 }, (_, index): Refund => ({
        ...base, id: `cancelled-${String(index).padStart(3, "0")}`, status: "CANCELLED", reason: `cancelled-${index}`,
        createdAt: end, completedAt: null,
      })),
    ];
    const fixture = historyFixture(5, false, refunds);
    const result = await fixture.service.listPurchaseHistory({ shopId: "shop-1" });
    expect(result.purchases[0]).toMatchObject({
      latestRefund: { reason: "cancelled-49" }, completedRefund: { reason: "older-z" },
    });
    expect(result.purchases.slice(1).every(row => row.completedRefund === null)).toBe(true);
    expect(fixture.repositoryCalls()).toBe(3);
  });
});
