import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { MerchantRecoveryCapacityReadService } from "../../../../app/services/billing/merchant-recovery-capacity-read.service";

const shopId = "shop-1";
const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");

type FixtureOptions = {
  planKind?: "FREE" | "PAID_METERED";
  status?: string;
  missingPeriod?: boolean;
  lifetime?: { grantedQuantity: number; committedQuantity: number; reservedQuantity: number } | null;
  purchased?: { grantedQuantity: number; committedQuantity: number; reservedQuantity: number; refundingQuantity: number } | null;
  periodCounter?: { grantedQuantity: number; committedQuantity: number; reservedQuantity: number; forfeitedQuantity: number; shopId?: string; billingPeriodId?: string } | null;
  periodOverrides?: Record<string, unknown>;
  selection?: Record<string, unknown> | null;
  subscriptionOverrides?: Record<string, unknown>;
};

function createService(options: FixtureOptions = {}) {
  const planKind = options.planKind ?? "FREE";
  const plan = {
    id: "plan-1",
    shopifyPlanHandle: planKind === "FREE" ? "free" : "growth",
    name: planKind === "FREE" ? "Free" : "Growth",
    kind: planKind,
    active: true,
  };
  const paidPeriod = planKind === "PAID_METERED" && !options.missingPeriod
    ? {
        id: "period-1",
        shopId,
        subscriptionId: "subscription-1",
        planId: plan.id,
        shopifyPlanHandleSnapshot: plan.shopifyPlanHandle,
        planKindSnapshot: "PAID_METERED",
        periodStart,
        periodEnd,
        status: "OPEN",
        entitlementCounters: options.periodCounter === null
          ? []
          : [{
              shopId,
              billingPeriodId: "period-1",
              counter: "INCLUDED_RECOVERY_CREDITS",
              grantedQuantity: 30,
              committedQuantity: 4,
              reservedQuantity: 3,
              forfeitedQuantity: 2,
              ...options.periodCounter,
            }],
        ...options.periodOverrides,
      }
    : null;
  const subscription = {
    id: "subscription-1",
    planId: plan.id,
    status: options.status ?? "ACTIVE",
    observedShopifyPlanHandle: plan.shopifyPlanHandle,
    billingPeriodId: paidPeriod?.id ?? null,
    currentPeriodStart: paidPeriod?.periodStart ?? null,
    currentPeriodEnd: paidPeriod?.periodEnd ?? null,
    plan,
    billingPeriod: paidPeriod,
    ...options.subscriptionOverrides,
  };
  const findSubscription = vi.fn().mockResolvedValue(subscription);
  const findCounter = vi.fn().mockImplementation(async ({ where }: { where: { shopId_counter: { counter: string } } }) =>
    where.shopId_counter.counter === "PURCHASED_RECOVERY_CREDITS"
      ? options.purchased === undefined
        ? { grantedQuantity: 20, committedQuantity: 5, reservedQuantity: 2, refundingQuantity: 3 }
        : options.purchased
      : options.lifetime === undefined
        ? { grantedQuantity: 10, committedQuantity: 2, reservedQuantity: 1 }
        : options.lifetime,
  );
  const findSelection = vi.fn().mockResolvedValue(options.selection ?? null);
  const findTopUpConfiguration = vi.fn().mockResolvedValue({ enabled: true, creditsPerPack: 50 });
  const database = {
    subscription: {
      findUnique: findSubscription,
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    shopEntitlementCounter: { findUnique: findCounter },
    merchantPromotionSelection: { findUnique: findSelection },
    $transaction: vi.fn(),
  };
  const planResolutionService = {
    readRecoveryCreditTopUpConfiguration: findTopUpConfiguration,
  };
  const service = new MerchantRecoveryCapacityReadService(
    database as unknown as PrismaClient,
    planResolutionService as never,
  );
  return {
    service,
    database,
    findCounter,
    findSelection,
    findTopUpConfiguration,
    subscription,
    paidPeriod,
  };
}

function activePromotion(overrides: Record<string, unknown> = {}) {
  return {
    promotionalCreditGrant: {
      quantity: 12,
      committedQuantity: 2,
      reservedQuantity: 4,
      campaign: {
        scope: "GLOBAL",
        status: "ACTIVE",
        startsAt: new Date("2026-09-01T00:00:00.000Z"),
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      ...overrides,
    },
  };
}

describe("MerchantRecoveryCapacityReadService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves capacity-source precedence and each fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
    const cases = [
      { name: "PROMOTIONAL", options: { selection: activePromotion() }, expected: "PROMOTIONAL" },
      { name: "PAID_INCLUDED", options: { planKind: "PAID_METERED" as const, purchased: null, lifetime: null }, expected: "PAID_INCLUDED" },
      { name: "PURCHASED", options: { purchased: { grantedQuantity: 20, committedQuantity: 5, reservedQuantity: 2, refundingQuantity: 3 } }, expected: "PURCHASED" },
      { name: "FREE_LIFETIME", options: { purchased: { grantedQuantity: 10, committedQuantity: 5, reservedQuantity: 5, refundingQuantity: 0 } }, expected: "FREE_LIFETIME" },
      { name: "EXHAUSTED", options: { lifetime: { grantedQuantity: 0, committedQuantity: 0, reservedQuantity: 0 }, purchased: { grantedQuantity: 0, committedQuantity: 0, reservedQuantity: 0, refundingQuantity: 0 } }, expected: "EXHAUSTED" },
    ];

    for (const testCase of cases) {
      const { service } = createService(testCase.options);
      const result = await service.getMerchantRecoveryCapacityState(shopId);
      expect(result.capacitySource, testCase.name).toBe(testCase.expected);
      expect(result.canStartRecovery, testCase.name).toBe(testCase.expected !== "EXHAUSTED");
    }
  });

  it("validates promotional targets, windows, and reserved/committed arithmetic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
    const eligible = createService({
      planKind: "PAID_METERED",
      selection: activePromotion({
        quantity: 12,
        committedQuantity: 2,
        reservedQuantity: 4,
        campaign: {
          scope: "PLAN",
          targetPlanId: "plan-1",
          status: "ACTIVE",
          startsAt: new Date("2026-09-01T00:00:00.000Z"),
          expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      }),
    });
    const mapped = await eligible.service.getMerchantRecoveryCapacityState(shopId);
    expect(mapped.capacitySource).toBe("PROMOTIONAL");
    expect(mapped.promotional).toEqual({ granted: 12, committed: 2, reserved: 4, remaining: 6 });

    const invalid = createService({
      selection: activePromotion({
        quantity: 12,
        committedQuantity: 8,
        reservedQuantity: 5,
      }),
    });
    const rejectedPromotion = await invalid.service.getMerchantRecoveryCapacityState(shopId);
    expect(rejectedPromotion.promotional).toEqual({ granted: 0, committed: 0, reserved: 0, remaining: 0 });
    expect(rejectedPromotion.capacitySource).toBe("PURCHASED");

    const invalidCampaigns = [
      { name: "target mismatch", campaign: { scope: "PLAN", targetPlanId: "other-plan" } },
      { name: "inactive", campaign: { scope: "GLOBAL", status: "PAUSED" } },
      { name: "not started", campaign: { scope: "GLOBAL", startsAt: new Date("2026-09-15T00:00:00.000Z") } },
      { name: "expired", campaign: { scope: "GLOBAL", expiresAt: new Date("2026-09-13T00:00:00.000Z") } },
    ];
    for (const invalidCampaign of invalidCampaigns) {
      const serviceWithInvalidCampaign = createService({
        selection: activePromotion({ campaign: {
          status: "ACTIVE",
          startsAt: new Date("2026-09-01T00:00:00.000Z"),
          expiresAt: new Date("2026-10-01T00:00:00.000Z"),
          ...invalidCampaign.campaign,
        } }),
      });
      const invalidCampaignResult = await serviceWithInvalidCampaign.service
        .getMerchantRecoveryCapacityState(shopId);
      expect(invalidCampaignResult.promotional.remaining, invalidCampaign.name).toBe(0);
      expect(invalidCampaignResult.capacitySource, invalidCampaign.name).toBe("PURCHASED");
    }
  });

  it.each([
    ["NO_CONTRACT", "CONTRACT_REQUIRED"],
    ["FROZEN", "CONTRACT_FROZEN"],
  ] as const)("blocks admission for %s while retaining balances", async (status, availability) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
    const { service, findTopUpConfiguration } = createService({
      planKind: "PAID_METERED",
      status,
      selection: activePromotion(),
    });

    const result = await service.getMerchantRecoveryCapacityState(shopId);
    expect(result).toMatchObject({ availability, capacitySource: null, canStartRecovery: false });
    expect(result.purchased.available).toBe(10);
    expect(result.promotional.remaining).toBe(6);
    expect(result.paidIncluded?.remaining).toBe(status === "FROZEN" ? 21 : undefined);
    expect(findTopUpConfiguration).toHaveBeenCalledWith("growth");
    expect(findTopUpConfiguration).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing period", { missingPeriod: true }],
    ["missing counter", { periodCounter: null }],
    ["identity mismatch", { periodCounter: { grantedQuantity: 30, committedQuantity: 4, reservedQuantity: 3, forfeitedQuantity: 2, billingPeriodId: "other-period" } }],
    ["invalid balances", { periodCounter: { grantedQuantity: 5, committedQuantity: 4, reservedQuantity: 3, forfeitedQuantity: 2 } }],
  ] as const)("fails closed for a paid projection with %s", async (_name, overrides) => {
    const { service } = createService({
      planKind: "PAID_METERED",
      purchased: null,
      lifetime: null,
      ...overrides,
    });

    const result = await service.getMerchantRecoveryCapacityState(shopId);
    expect(result).toMatchObject({ availability: "CONFIGURATION_UNAVAILABLE", capacitySource: null, canStartRecovery: false });
    expect(result.paidIncluded).toBeNull();
  });

  it("preserves read shapes, reuses the catalogue reader once, and performs no writes or provider calls", async () => {
    const { service, database, findCounter, findSelection, findTopUpConfiguration } = createService();

    await service.getMerchantRecoveryCapacityState(shopId);

    expect(database.subscription.findUnique).toHaveBeenCalledWith({
      where: { shopId },
      include: {
        plan: true,
        billingPeriod: {
          include: {
            entitlementCounters: {
              where: { counter: "INCLUDED_RECOVERY_CREDITS" },
            },
          },
        },
      },
    });
    expect(findCounter).toHaveBeenCalledTimes(2);
    expect(findSelection).toHaveBeenCalledWith({
      where: { shopId },
      include: { promotionalCreditGrant: { include: { campaign: true } } },
    });
    expect(findTopUpConfiguration).toHaveBeenCalledWith("free");
    expect(database.subscription.create).not.toHaveBeenCalled();
    expect(database.subscription.update).not.toHaveBeenCalled();
    expect(database.subscription.upsert).not.toHaveBeenCalled();
    expect(database.subscription.delete).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});