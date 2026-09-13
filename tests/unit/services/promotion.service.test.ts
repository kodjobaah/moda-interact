import { describe, expect, it, vi } from "vitest";

import {
  getEligiblePromotionOffers,
  PromotionSelectionError,
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
    }));
    expect(offers[0]).not.toHaveProperty("targetPlanId");
    expect(offers[0]).not.toHaveProperty("targetShopId");
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
      campaign: { expiresAt: new Date("2026-09-30T00:00:00.000Z"), status: "ACTIVE" },
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
      .rejects.toMatchObject<PromotionSelectionError>({ code: "ACTIVE_PROMOTION_ALREADY_SELECTED" });
  });
});
