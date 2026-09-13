import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import { selectPromotionOffer } from "../../app/services/promotions/promotion.service";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = Boolean(testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1");
const describeWithDatabase = integrationEnabled ? describe : describe.skip;

const fixtureId = randomUUID();
const adminId = `admin-${fixtureId}`;
const planId = `plan-${fixtureId}`;
const shopId = `shop-${fixtureId}`;
const campaignAId = `campaign-a-${fixtureId}`;
const campaignBId = `campaign-b-${fixtureId}`;

const database = testDatabaseUrl ? new PrismaClient({ datasourceUrl: testDatabaseUrl }) : null;
const firstClient = testDatabaseUrl ? new PrismaClient({ datasourceUrl: testDatabaseUrl }) : null;
const secondClient = testDatabaseUrl ? new PrismaClient({ datasourceUrl: testDatabaseUrl }) : null;

async function resetSelection(): Promise<void> {
  if (!database) return;
  await database.merchantPromotionSelection.deleteMany({ where: { shopId } });
  await database.promotionalCreditGrant.deleteMany({ where: { shopId } });
}

describeWithDatabase(
  "Promotion selection PostgreSQL concurrency (requires MODA_DISPOSABLE_INTEGRATION=1 and TEST_DATABASE_URL)",
  () => {
    afterAll(async () => {
      if (!database) return;
      await database.merchantPromotionSelection.deleteMany({ where: { shopId } });
      await database.promotionalCreditGrant.deleteMany({ where: { shopId } });
      await database.promotionCampaign.deleteMany({ where: { id: { in: [campaignAId, campaignBId] } } });
      await database.subscription.deleteMany({ where: { shopId } });
      await database.shop.deleteMany({ where: { id: shopId } });
      await database.billingPlan.deleteMany({ where: { id: planId } });
      await database.platformAdmin.deleteMany({ where: { id: adminId } });
      await Promise.all([database.$disconnect(), firstClient?.$disconnect(), secondClient?.$disconnect()]);
    });

    it("allows exactly one winner when two different campaigns are selected concurrently", async () => {
      if (!database || !firstClient || !secondClient) throw new Error("Disposable database clients are unavailable");

      await database.platformAdmin.create({ data: { id: adminId, email: `${adminId}@example.test`, role: "SUPER_ADMIN", active: true } });
      await database.billingPlan.create({
        data: {
          id: planId,
          shopifyPlanHandle: planId,
          name: "Promotion integration plan",
          kind: "PAID_METERED",
          active: true,
          shopifyUsageEventHandle: "promotion-meter",
          includedRecoveryConversationAllowance: 100,
          defaultOutboundSoftLimit: 10,
          defaultOutboundHardLimit: 20,
          terminalMessageReservedSlots: 1,
        },
      });
      await database.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
      await database.subscription.create({ data: { shopId, planId, status: "ACTIVE", observedShopifyPlanHandle: planId } });
      await database.promotionCampaign.createMany({
        data: [
          { id: campaignAId, name: "Campaign A", merchantDescription: "A", scope: "GLOBAL", quantity: 25, startsAt: new Date("2026-09-01T00:00:00.000Z"), expiresAt: new Date("2026-10-01T00:00:00.000Z"), status: "ACTIVE", createdByPlatformAdminId: adminId },
          { id: campaignBId, name: "Campaign B", merchantDescription: "B", scope: "GLOBAL", quantity: 40, startsAt: new Date("2026-09-01T00:00:00.000Z"), expiresAt: new Date("2026-10-01T00:00:00.000Z"), status: "ACTIVE", createdByPlatformAdminId: adminId },
        ],
      });

      const outcomes = await Promise.allSettled([
        selectPromotionOffer(shopId, campaignAId, new Date("2026-09-13T12:00:00.000Z"), firstClient),
        selectPromotionOffer(shopId, campaignBId, new Date("2026-09-13T12:00:00.000Z"), secondClient),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason?.code === "ACTIVE_PROMOTION_ALREADY_SELECTED")).toHaveLength(1);
      expect(await database.merchantPromotionSelection.count({ where: { shopId } })).toBe(1);
      expect(await database.promotionalCreditGrant.count({ where: { shopId } })).toBe(1);

      const selection = await database.merchantPromotionSelection.findUnique({ where: { shopId }, include: { promotionalCreditGrant: true } });
      expect([25, 40]).toContain(selection?.promotionalCreditGrant.quantity);
    }, 30_000);

    it("reuses one exact grant when the same campaign is selected concurrently", async () => {
      if (!database || !firstClient || !secondClient) throw new Error("Disposable database clients are unavailable");
      await resetSelection();

      const outcomes = await Promise.allSettled([
        selectPromotionOffer(shopId, campaignAId, new Date("2026-09-13T12:00:00.000Z"), firstClient),
        selectPromotionOffer(shopId, campaignAId, new Date("2026-09-13T12:00:00.000Z"), secondClient),
      ]);

      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      const grant = await database.promotionalCreditGrant.findUnique({ where: { campaignId_shopId: { campaignId: campaignAId, shopId } } });
      expect(grant).toMatchObject({ quantity: 25, selectionCount: 2 });
      expect(await database.promotionalCreditGrant.count({ where: { campaignId: campaignAId, shopId } })).toBe(1);
      expect(await database.merchantPromotionSelection.count({ where: { shopId } })).toBe(1);
    }, 30_000);
  },
);
