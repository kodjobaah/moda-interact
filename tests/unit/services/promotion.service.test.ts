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

  it.each([
    ["wrong plan", { scope: "PLAN", targetPlanId: "plan-other", targetShopId: null }],
    ["wrong shop", { scope: "SHOP", targetPlanId: null, targetShopId: "shop-other" }],
  ] as const)("rejects a requested %s campaign", async (_label, targeting) => {
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign(targeting)) },
      merchantPromotionSelection: { findUnique: vi.fn() },
      promotionalCreditGrant: { upsert: vi.fn(), update: vi.fn() },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never))
      .rejects.toMatchObject({ code: "PROMOTION_NOT_ELIGIBLE" });
    expect(tx.promotionalCreditGrant.upsert).not.toHaveBeenCalled();
    expect(tx.merchantPromotionSelection.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["future", { status: "ACTIVE", startsAt: new Date("2026-09-14T00:00:00.000Z") }],
    ["expired", { status: "ACTIVE", expiresAt: new Date("2026-09-01T00:00:00.000Z") }],
    ["closed", { status: "CLOSED" }],
  ] as const)("rejects a requested %s campaign lifecycle", async (_label, lifecycle) => {
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign(lifecycle)) },
      merchantPromotionSelection: { findUnique: vi.fn() },
      promotionalCreditGrant: { upsert: vi.fn(), update: vi.fn() },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never))
      .rejects.toMatchObject({ code: "PROMOTION_NOT_ELIGIBLE" });
    expect(tx.promotionalCreditGrant.upsert).not.toHaveBeenCalled();
    expect(tx.merchantPromotionSelection.findUnique).not.toHaveBeenCalled();
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
    ["matching plan", { scope: "PLAN", targetPlanId: "plan-1", targetShopId: null }, true],
    ["matching shop", { scope: "SHOP", targetPlanId: null, targetShopId: "shop-1" }, true],
    ["different shop", { scope: "SHOP", targetPlanId: null, targetShopId: "shop-other" }, false],
  ] as const)("re-evaluates a current %s target before switching", async (_label, targeting, shouldBlock) => {
    const currentGrant = {
      id: "grant-old",
      campaignId: "campaign-old",
      quantity: 25,
      reservedQuantity: 0,
      committedQuantity: 1,
      exhaustedAt: null,
      campaign: { id: "campaign-old", startsAt: new Date("2026-09-01T00:00:00.000Z"), expiresAt: new Date("2026-09-30T00:00:00.000Z"), status: "ACTIVE", ...targeting },
    };
    const newGrant = { ...currentGrant, id: "grant-new", campaignId: "campaign-1", committedQuantity: 0, campaign: campaign() };
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign()) },
      merchantPromotionSelection: { findUnique: vi.fn().mockResolvedValue({ promotionalCreditGrant: currentGrant }), upsert: vi.fn() },
      promotionalCreditGrant: { upsert: vi.fn().mockResolvedValue(newGrant), update: vi.fn() },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    if (shouldBlock) {
      await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never))
        .rejects.toMatchObject({ code: "ACTIVE_PROMOTION_ALREADY_SELECTED" });
      expect(tx.promotionalCreditGrant.upsert).not.toHaveBeenCalled();
    } else {
      await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never)).resolves.toEqual(expect.objectContaining({ campaignId: "campaign-1" }));
      expect(tx.promotionalCreditGrant.upsert).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ["partially used", { quantity: 25, reservedQuantity: 3, committedQuantity: 7, exhaustedAt: null }, 15],
    ["exhausted", { quantity: 25, reservedQuantity: 0, committedQuantity: 25, exhaustedAt: now }, 0],
  ] as const)("reopens a same-campaign grant without changing quantity when %s", async (_label, quantities, remainingQuantity) => {
    const existingGrant = { id: "grant-1", shopId: "shop-1", campaignId: "campaign-1", ...quantities, firstSelectedAt: now, lastSelectedAt: now, selectionCount: 3, campaign: { status: "ACTIVE", startsAt: campaign().startsAt, expiresAt: campaign().expiresAt } };
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign()) },
      merchantPromotionSelection: { findUnique: vi.fn().mockResolvedValue({ promotionalCreditGrant: existingGrant }), upsert: vi.fn() },
      promotionalCreditGrant: { upsert: vi.fn().mockResolvedValue(existingGrant), update: vi.fn() },
    };
    const database = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never)).resolves.toMatchObject({ remainingQuantity });
    expect(tx.promotionalCreditGrant.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {}, create: { campaignId: "campaign-1", shopId: "shop-1", quantity: 25 } }));
    expect(tx.promotionalCreditGrant.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ quantity: expect.anything(), reservedQuantity: expect.anything(), committedQuantity: expect.anything() }) }));
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
    ["suspended shop", { shopStatus: "SUSPENDED", subscription: context().subscription }],
    ["frozen subscription", { shopStatus: "ACTIVE", subscription: { ...context().subscription, status: "FROZEN" } }],
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

  it("retries once and returns the successful same-campaign selection", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("serialization failure", { code: "P2034", clientVersion: "test" });
    const grant = { id: "grant-1", quantity: 25, reservedQuantity: 0, committedQuantity: 0, exhaustedAt: null, firstSelectedAt: null, lastSelectedAt: null };
    const tx = {
      shop: { findUnique: vi.fn().mockResolvedValue(context()) },
      promotionCampaign: { findUnique: vi.fn().mockResolvedValue(campaign()) },
      merchantPromotionSelection: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
      promotionalCreditGrant: { upsert: vi.fn().mockResolvedValue(grant), update: vi.fn() },
    };
    const database = { $transaction: vi.fn().mockRejectedValueOnce(conflict).mockImplementationOnce(async (callback) => callback(tx)) };

    await expect(selectPromotionOffer("shop-1", "campaign-1", now, database as never)).resolves.toMatchObject({ campaignId: "campaign-1" });
    expect(database.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.promotionalCreditGrant.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ firstSelectedAt: now, lastSelectedAt: now }) }));
  });
});
