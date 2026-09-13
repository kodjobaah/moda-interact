import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import {
  getEligiblePromotionOffers,
  selectPromotionOffer,
} from "@/services/promotions/promotion.service";

const now = new Date("2026-09-13T12:00:00.000Z");

function context() {
  return {
    id: "shop-1",
    status: "ACTIVE",
    subscription: {
      status: "ACTIVE",
      planId: "plan-1",
      plan: { id: "plan-1", name: "Paid", active: true },
    },
  };
}

function campaign(overrides = {}) {
  return {
    id: "campaign-1",
    name: "Recovery launch",
    merchantDescription: "A launch offer",
    scope: "GLOBAL",
    quantity: 25,
    startsAt: new Date("2026-09-01T00:00:00.000Z"),
    expiresAt: new Date("2026-09-30T00:00:00.000Z"),
    status: "ACTIVE",
    targetPlanId: null,
    targetShopId: null,
    promotionalCreditGrants: [],
    ...overrides,
  };
}

describe("promotion service", () => {
  it("returns only currently running campaigns targeted to the shop or its plan", async () => {
    const findMany = vi.fn().mockResolvedValue([campaign()]);
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findMany },
    };

    const offers = await getEligiblePromotionOffers("shop-1", now, database as never);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "ACTIVE",
        startsAt: { lte: now },
        expiresAt: { gt: now },
        OR: expect.arrayContaining([
          { scope: "GLOBAL" },
          { scope: "SHOP", targetShopId: "shop-1" },
          { scope: "PLAN", targetPlanId: "plan-1" },
        ]),
      }),
    }));
    expect(offers[0]).toEqual(expect.objectContaining({
      id: "campaign-1",
      name: "Recovery launch",
      quantity: 25,
      remainingQuantity: 25,
      eligible: true,
      currentlySelected: false,
      previouslyClaimed: false,
    }));
    expect(offers[0]).not.toHaveProperty("targetPlanId");
    expect(offers[0]).not.toHaveProperty("targetShopId");
  });

  it.each([
    ["wrong plan", { scope: "PLAN", targetPlanId: "plan-other", targetShopId: null }],
    ["wrong shop", { scope: "SHOP", targetPlanId: null, targetShopId: "shop-other" }],
  ])("does not include a %s campaign in the catalogue query", async (_label, targeting) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findMany },
    };

    await getEligiblePromotionOffers("shop-1", now, database as never);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.not.arrayContaining([targeting]),
      }),
    }));
  });

  it("projects a historical grant separately from the current selection", async () => {
    const findMany = vi.fn().mockResolvedValue([
      campaign({
        id: "campaign-old",
        promotionalCreditGrants: [{ quantity: 25, reservedQuantity: 3, committedQuantity: 2, exhaustedAt: null, firstSelectedAt: now, lastSelectedAt: now, selection: null }],
      }),
      campaign({
        id: "campaign-current",
        promotionalCreditGrants: [{ quantity: 25, reservedQuantity: 0, committedQuantity: 0, exhaustedAt: null, firstSelectedAt: now, lastSelectedAt: now, selection: { shopId: "shop-1" } }],
      }),
    ]);
    const database = { shop: { findUnique: vi.fn().mockResolvedValue(context()) }, promotionCampaign: { findMany } };

    const offers = await getEligiblePromotionOffers("shop-1", now, database as never);

    expect(offers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "campaign-old", previouslyClaimed: true, currentlySelected: false, remainingQuantity: 20 }),
      expect.objectContaining({ id: "campaign-current", previouslyClaimed: true, currentlySelected: true }),
    ]));
  });

  it("creates one exact grant and selection, then reselects without adding quantity", async () => {
    const grant = {
      id: "grant-1",
      shopId: "shop-1",
      campaignId: "campaign-1",
      quantity: 25,
      reservedQuantity: 0,
      committedQuantity: 0,
      firstSelectedAt: null,
      lastSelectedAt: null,
      selectionCount: 0,
      exhaustedAt: null,
      campaign: { expiresAt: campaign().expiresAt, status: "ACTIVE" },
    };
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign()) },
      merchantPromotionSelection: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({ promotionalCreditGrant: grant }),
        upsert: vi.fn(),
      },
      promotionalCreditGrant: {
        upsert: vi.fn().mockResolvedValue(grant),
        update: vi.fn(),
      },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await selectPromotionOffer("shop-1", "campaign-1", now, database as never);
    await selectPromotionOffer("shop-1", "campaign-1", now, database as never);

    expect(tx.promotionalCreditGrant.upsert).toHaveBeenCalledTimes(2);
    expect(tx.promotionalCreditGrant.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { campaignId_shopId: { campaignId: "campaign-1", shopId: "shop-1" } },
      create: { campaignId: "campaign-1", shopId: "shop-1", quantity: 25 },
      update: {},
    }));
    expect(tx.promotionalCreditGrant.update).toHaveBeenCalledTimes(2);
    expect(tx.merchantPromotionSelection.upsert).toHaveBeenCalledTimes(2);
  });

  it("blocks switching away from a different still-usable selection", async () => {
    const currentGrant = {
      id: "grant-old",
      shopId: "shop-1",
      campaignId: "campaign-old",
      quantity: 25,
      reservedQuantity: 0,
      committedQuantity: 1,
      exhaustedAt: null,
      campaign: {
        id: "campaign-old",
        startsAt: new Date("2026-09-01T00:00:00.000Z"),
        expiresAt: new Date("2026-09-30T00:00:00.000Z"),
        status: "ACTIVE",
        scope: "GLOBAL",
        targetPlanId: null,
        targetShopId: null,
      },
    };
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign()) },
      merchantPromotionSelection: {
        findUnique: vi.fn().mockResolvedValue({ promotionalCreditGrant: currentGrant }),
      },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never))
      .rejects.toMatchObject({ code: "ACTIVE_PROMOTION_ALREADY_SELECTED" });
  });

  it("permits switching when the current campaign no longer matches the merchant plan", async () => {
    const currentGrant = {
      id: "grant-old",
      campaignId: "campaign-old",
      quantity: 25,
      reservedQuantity: 0,
      committedQuantity: 1,
      exhaustedAt: null,
      campaign: { id: "campaign-old", startsAt: new Date("2026-09-01T00:00:00.000Z"), expiresAt: new Date("2026-09-30T00:00:00.000Z"), status: "ACTIVE", scope: "PLAN", targetPlanId: "plan-old", targetShopId: null },
    };
    const grant = { ...currentGrant, id: "grant-new", campaignId: "campaign-1", quantity: 25, reservedQuantity: 0, committedQuantity: 0 };
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign()) },
      merchantPromotionSelection: { findUnique: vi.fn().mockResolvedValue({ promotionalCreditGrant: currentGrant }), upsert: vi.fn() },
      promotionalCreditGrant: { upsert: vi.fn().mockResolvedValue(grant), update: vi.fn() },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never)).resolves.toEqual(expect.objectContaining({ campaignId: "campaign-1" }));
    expect(tx.promotionalCreditGrant.upsert).toHaveBeenCalledOnce();
  });

  it.each([
    ["expired", { status: "ACTIVE", startsAt: new Date("2026-08-01T00:00:00.000Z"), expiresAt: new Date("2026-09-01T00:00:00.000Z"), scope: "GLOBAL", targetPlanId: null, targetShopId: null }],
    ["closed", { status: "CLOSED", startsAt: new Date("2026-09-01T00:00:00.000Z"), expiresAt: new Date("2026-09-30T00:00:00.000Z"), scope: "GLOBAL", targetPlanId: null, targetShopId: null }],
    ["exhausted", { status: "ACTIVE", startsAt: new Date("2026-09-01T00:00:00.000Z"), expiresAt: new Date("2026-09-30T00:00:00.000Z"), scope: "GLOBAL", targetPlanId: null, targetShopId: null, exhaustedAt: now }],
  ] as const)("permits replacement when the old campaign is %s", async (label, oldCampaign) => {
    const exhaustedAt = label === "exhausted" ? now : null;
    const currentGrant = { id: "grant-old", campaignId: "campaign-old", quantity: 25, reservedQuantity: exhaustedAt ? 25 : 0, committedQuantity: 0, exhaustedAt, campaign: { id: "campaign-old", ...oldCampaign } };
    const grant = { ...currentGrant, id: "grant-new", campaignId: "campaign-1", quantity: 25, reservedQuantity: 0, exhaustedAt: null };
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign()) },
      merchantPromotionSelection: { findUnique: vi.fn().mockResolvedValue({ promotionalCreditGrant: currentGrant }), upsert: vi.fn() },
      promotionalCreditGrant: { upsert: vi.fn().mockResolvedValue(grant), update: vi.fn() },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never)).resolves.toEqual(expect.objectContaining({ campaignId: "campaign-1" }));
  });

  it.each([
    ["inactive shop", { shopStatus: "FROZEN", subscription: context().subscription }],
    ["no contract", { shopStatus: "ACTIVE", subscription: { ...context().subscription, status: "NO_CONTRACT" } }],
    ["inactive plan", { shopStatus: "ACTIVE", subscription: { ...context().subscription, plan: { ...context().subscription.plan, active: false } } }],
  ])("fails closed for an %s", async (_label, unavailableContext) => {
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", status: unavailableContext.shopStatus, subscription: unavailableContext.subscription }) },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never))
      .rejects.toMatchObject({ code: "PROMOTION_SELECTION_UNAVAILABLE" });
  });

  it("retries serialization conflicts three times and then returns unavailable", async () => {
    const conflict = () => new Prisma.PrismaClientKnownRequestError("serialization failure", { code: "P2034", clientVersion: "test" });
    const database = { $transaction: vi.fn().mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never))
      .rejects.toMatchObject({ code: "PROMOTION_SELECTION_UNAVAILABLE" });
    expect(database.$transaction).toHaveBeenCalledTimes(3);
  });
});
