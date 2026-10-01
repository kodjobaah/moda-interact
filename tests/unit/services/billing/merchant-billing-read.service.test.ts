import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import type {
  BillingProvider,
  MerchantShopifySubscriptionState,
  ProviderSubscription,
} from "../../../../app/services/billing/billing.types";
import { MerchantBillingReadService } from "../../../../app/services/billing/merchant-billing-read.service";

const shopId = "shop-1";
const shopifyShopId = "gid://shopify/Shop/1";
const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");

function providerSubscription(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    provider: "SHOPIFY",
    planHandle: "free",
    billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: {
      handle: "free",
      description: "Free",
      price: { amount: "0.00", currency: "USD" },
    },
    pendingFlatRatePlan: null,
    usageItems: [{
      handle: "credit-pack-meter",
      description: "Recovery credit pack",
      price: { kind: "TIERED", active: true, currency: "USD", tiersMode: "VOLUME", tiers: [] },
      usage: { quantity: 2, costAmount: "2.00", costCurrency: "USD" },
    }],
    usageEventHandles: ["credit-pack-meter", "unknown-meter"],
    pendingPlanHandle: null,
    pendingEffectiveAt: null,
    status: "ACTIVE",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-subscription-1",
    providerUsageSnapshot: [],
    ...overrides,
  };
}

function activeCommercialState(): MerchantShopifySubscriptionState {
  return {
    status: "ACTIVE_SUBSCRIPTION",
    subscription: {
      planHandle: "free",
      description: "Free",
      price: { amount: "0.00", currency: "USD" },
      billingPeriod: "EVERY_30_DAYS",
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
      trialEndsAt: null,
      cancelAtEndOfCycle: false,
      pendingUpdate: null,
      usageItems: providerSubscription().usageItems,
    },
    modaMapping: { id: "free-plan", name: "Free", kind: "FREE" },
    mappingStatus: "MAPPED",
    pendingModaMapping: null,
  };
}

function createService(options: {
  planKind?: "FREE" | "PAID_METERED";
  subscriptionOverrides?: Record<string, unknown>;
  periodOverrides?: Record<string, unknown>;
  periodCounterOverrides?: Record<string, unknown>;
  shop?: Record<string, unknown> | null;
  provider?: BillingProvider;
  catalogue?: Record<string, unknown> | null;
  latestPurchase?: Record<string, unknown> | null;
  unresolvedPurchases?: Array<Record<string, unknown>>;
} = {}) {
  const planKind = options.planKind ?? "FREE";
  const planHandle = planKind === "FREE" ? "free" : "growth";
  const plan = {
    id: planKind === "FREE" ? "free-plan" : "growth-plan",
    kind: planKind,
    shopifyPlanHandle: planHandle,
    active: true,
    recoveryCreditPackEnabled: true,
    recoveryCreditsPerPack: 100,
  };
  const period = {
    id: "period-1",
    shopId,
    subscriptionId: "subscription-1",
    planId: plan.id,
    shopifyPlanHandleSnapshot: planHandle,
    planKindSnapshot: planKind,
    periodStart,
    periodEnd,
    status: "OPEN",
    includedRecoveryCreditsGranted: planKind === "PAID_METERED" ? 100 : null,
    entitlementCounters: planKind === "PAID_METERED"
      ? [{
          shopId,
          billingPeriodId: "period-1",
          counter: "INCLUDED_RECOVERY_CREDITS",
          grantedQuantity: 100,
          committedQuantity: 12,
          reservedQuantity: 8,
          forfeitedQuantity: 5,
          ...options.periodCounterOverrides,
        }]
      : [],
    ...options.periodOverrides,
  };
  const subscription = {
    id: "subscription-1",
    status: "ACTIVE",
    planId: plan.id,
    billingPeriodId: "period-1",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    observedShopifyPlanHandle: planHandle,
    plan,
    pendingPlan: null,
    billingPeriod: period,
    ...options.subscriptionOverrides,
  };
  const findPlan = vi.fn().mockResolvedValue(options.catalogue === undefined
    ? {
        shopifyPlanHandle: planHandle,
        usageEvents: [{ position: 0, eventHandle: "credit-pack-meter", adminLabel: "Credit pack", creditsGrantedPerUnit: 100 }],
      }
    : options.catalogue);
  const findLatestPurchase = vi.fn().mockResolvedValue(options.latestPurchase ?? null);
  const findUnresolvedPurchases = vi.fn().mockResolvedValue(options.unresolvedPurchases ?? []);
  const database = {
    shop: {
      findUnique: vi.fn().mockResolvedValue(options.shop === undefined
        ? { id: shopId, status: "ACTIVE", shopifyShopId }
        : options.shop),
    },
    subscription: { findUnique: vi.fn().mockResolvedValue(subscription) },
    shopEntitlementCounter: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { shopId_counter: { counter: string } } }) =>
        where.shopId_counter.counter === "PURCHASED_RECOVERY_CREDITS"
          ? { grantedQuantity: 100, committedQuantity: 20, reservedQuantity: 5, refundingQuantity: 10 }
          : { grantedQuantity: 50, committedQuantity: 10, reservedQuantity: 5 }),
    },
    usageEvent: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 999 } }) },
    recoveryCreditPurchase: {
      findFirst: findLatestPurchase,
      findMany: findUnresolvedPurchases,
    },
    billingPlan: { findUnique: vi.fn() },
  };
  const provider = options.provider ?? {
    getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ planHandle })),
  };
  const readMerchantPricingPlan = findPlan;
  const service = new MerchantBillingReadService(
    provider,
    database as unknown as PrismaClient,
    { readMerchantPricingPlan } as never,
  );

  return { service, database, provider, readMerchantPricingPlan, subscription, period };
}

describe("MerchantBillingReadService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("composes Free lifetime, usage and purchased balances with no cycle/provider lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
    const { service, provider } = createService({ shop: { id: shopId, status: "ACTIVE", shopifyShopId: null } });

    const result = await service.getMerchantBillingState(shopId);

    expect(result).toMatchObject({
      allowance: 50,
      committed: 10,
      reserved: 5,
      remaining: 35,
      paidIncluded: null,
      paidConfigurationUnavailable: false,
      lifetimeFree: { grantedQuantity: 50, remaining: 35 },
      usageQuantity: 999,
      purchasedRecoveryCredits: {
        grantedQuantity: 100,
        committedQuantity: 20,
        reservedQuantity: 5,
        refundingQuantity: 10,
        available: 65,
      },
      billingPeriodPhase: "ACTIVE",
    });
    expect(provider.getActiveSubscription).not.toHaveBeenCalled();
  });

  it("presents included Paid credits only for an exact valid local period and counter", async () => {
    const valid = createService({ planKind: "PAID_METERED", shop: { id: shopId, shopifyShopId: null } });
    const result = await valid.service.getMerchantBillingState(shopId);
    expect(result).toMatchObject({
      allowance: null,
      remaining: null,
      paidIncluded: {
        grantedQuantity: 100,
        committedQuantity: 12,
        reservedQuantity: 8,
        forfeitedQuantity: 5,
        remaining: 75,
      },
      paidConfigurationUnavailable: false,
    });

    const invalid = createService({
      planKind: "PAID_METERED",
      periodCounterOverrides: { committedQuantity: Number.MAX_SAFE_INTEGER + 1 },
      shop: { id: shopId, shopifyShopId: null },
    });
    const invalidResult = await invalid.service.getMerchantBillingState(shopId);
    expect(invalidResult.paidIncluded).toBeNull();
    expect(invalidResult.paidConfigurationUnavailable).toBe(true);
  });

  it("reuses supplied verified commercial state without another provider read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
    const { service, provider, readMerchantPricingPlan, database } = createService();

    const result = await service.getMerchantBillingState(shopId, activeCommercialState());

    expect(result).toMatchObject({
      billingPeriodPhase: "ACTIVE",
      recoveryCreditOfferVerificationState: "VERIFIED",
      recoveryCreditPackMeterVerified: true,
      recoveryCreditPackPurchaseEligible: true,
      recoveryCreditOffers: [{ eventHandle: "credit-pack-meter", creditsGranted: 100 }],
    });
    expect(provider.getActiveSubscription).not.toHaveBeenCalled();
    expect(readMerchantPricingPlan).toHaveBeenCalledTimes(1);
    expect(database.billingPlan.findUnique).not.toHaveBeenCalled();
  });

  it("performs one provider read without SHOPIFY-003 plan mapping reads when no snapshot is supplied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
    const { service, provider, readMerchantPricingPlan, database } = createService();

    const result = await service.getMerchantBillingState(shopId);

    expect(result.recoveryCreditPackPurchaseEligible).toBe(true);
    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
    expect(provider.getActiveSubscription).toHaveBeenCalledWith({ shopifyShopId });
    expect(readMerchantPricingPlan).toHaveBeenCalledTimes(1);
    expect(database.billingPlan.findUnique).not.toHaveBeenCalled();
  });

  it("preserves local cycle phase and reports verification failure without offers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    const provider = { getActiveSubscription: vi.fn().mockRejectedValue(new Error("provider unavailable")) };
    const { service } = createService({ provider });

    const result = await service.getMerchantBillingState(shopId);

    expect(result).toMatchObject({
      billingPeriodPhase: "RECONCILING",
      recoveryCreditOffers: [],
      recoveryCreditOfferDiagnostics: [],
      recoveryCreditOfferVerificationState: "VERIFICATION_UNAVAILABLE",
      recoveryCreditPackMeterVerified: false,
      recoveryCreditPackPurchaseEligible: false,
      unavailableReason: "Shopify billing details could not be verified.",
    });
    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
  });

  it("retains offer diagnostics and history while cycle mismatch prevents purchasing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00.000Z"));
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
        usageItems: [
          ...providerSubscription().usageItems,
          {
            handle: "unknown-meter",
            description: "Unknown meter",
            price: { kind: "TIERED", active: true, currency: "USD", tiersMode: "VOLUME", tiers: [] },
            usage: { quantity: 0, costAmount: "0.00", costCurrency: "USD" },
          },
        ],
        currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      })),
    };
    const latestPurchase = {
      id: "purchase-1",
      status: "REQUESTED",
      creditsGranted: 100,
      currentAmount: 2,
      reservedAmount: 2,
      shopifyEventHandleSnapshot: "credit-pack-meter",
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
      activatedAt: null,
      usageEvent: { shopifyReportState: "REPORTED" },
    };
    const unresolvedPurchases = [{
      id: "purchase-1",
      shopifyEventHandleSnapshot: "credit-pack-meter",
      creditsGranted: 100,
      createdAt: latestPurchase.createdAt,
      usageEvent: { shopifyReportState: "REPORTED" },
    }];
    const { service } = createService({ provider, latestPurchase, unresolvedPurchases });

    const result = await service.getMerchantBillingState(shopId);

    expect(result).toMatchObject({
      recoveryCreditOffers: [{ eventHandle: "credit-pack-meter", label: "Credit pack" }],
      recoveryCreditOfferDiagnostics: [{ code: "UNKNOWN_PROVIDER_METER", handle: "unknown-meter" }],
      recoveryCreditPackPurchaseEligible: false,
      unavailableReason: "Recovery credit offers are not currently available.",
      latestPurchase: {
        id: "purchase-1",
        label: "Credit pack",
        usageReportState: "REPORTED",
        activatedAt: null,
      },
      unresolvedPurchases: [{ eventHandle: "credit-pack-meter", usageReportState: "REPORTED" }],
    });
  });
});