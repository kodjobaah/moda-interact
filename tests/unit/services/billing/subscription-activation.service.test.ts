import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";

import { SubscriptionActivationService } from "../../../../app/services/billing/subscription-activation.service";
import type { ProviderSubscription } from "../../../../app/services/billing/billing.types";
import { lockInitialFreeActivationState } from "../../../../app/services/billing/subscription-locks";

const plan = {
  id: "free-1",
  shopifyPlanHandle: "free",
  kind: BillingPlanKind.FREE,
  active: true,
};

function createHarness({
  kind = BillingPlanKind.FREE,
  currentSubscription = null,
  topUpEnabled = false,
}: {
  kind?: BillingPlanKind;
  currentSubscription?: Record<string, unknown> | null;
  topUpEnabled?: boolean;
} = {}) {
  const resolvedPlan = { ...plan, kind };
  const state: { currentSubscription: Record<string, unknown> | null } = { currentSubscription };
  const subscription = {
    findUnique: vi.fn().mockImplementation(async () => state.currentSubscription),
    upsert: vi.fn().mockImplementation(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      state.currentSubscription = { ...(state.currentSubscription ?? create), ...update, id: "subscription-1" };
      return state.currentSubscription;
    }),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.currentSubscription = { ...state.currentSubscription, ...data };
      return state.currentSubscription;
    }),
  };
  const transaction = {
    subscription,
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const database = {
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  const planResolutionService = {
    resolveOrMaterializeBillingPlan: vi.fn().mockResolvedValue({ kind: "READY", plan: resolvedPlan, materialized: false }),
    readRecoveryCreditTopUpConfiguration: vi.fn().mockResolvedValue({ enabled: topUpEnabled, creditsPerPack: topUpEnabled ? 100 : null }),
  };
  return {
    service: new SubscriptionActivationService(database as never, planResolutionService as never),
    database,
    planResolutionService,
    state,
    subscription,
    transaction,
    resolvedPlan,
  };
}

function createPaidFinalisationHarness({
  planOverrides = {},
  providerOverrides = {},
  shopStatus = "ACTIVE",
  billingPeriod = null,
  periodCounter = null,
  lifetimeCounter = null,
  policy = { lifetimeFreeRecoveryAllowance: 5 },
}: {
  planOverrides?: Record<string, unknown>;
  providerOverrides?: Partial<ProviderSubscription>;
  shopStatus?: string;
  billingPeriod?: Record<string, unknown> | null;
  periodCounter?: Record<string, unknown> | null;
  lifetimeCounter?: Record<string, unknown> | null;
  policy?: { lifetimeFreeRecoveryAllowance: number } | null;
} = {}) {
  const paidPlan = {
    id: "paid-1",
    active: true,
    kind: BillingPlanKind.PAID_METERED,
    shopifyPlanHandle: "growth",
    name: "Growth",
    shopifyUsageEventHandle: "paid-meter",
    includedRecoveryConversationAllowance: 25,
    ...planOverrides,
  };
  const subscriptionUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "subscription-1",
    ...data,
  }));
  const billingPeriodCreate = vi.fn().mockResolvedValue({ id: "period-1" });
  const periodCounterCreate = vi.fn().mockResolvedValue({});
  const lifetimeCounterCreate = vi.fn().mockResolvedValue({});
  const queryRaw = vi.fn().mockResolvedValue([]);
  const transaction = {
    $queryRaw: queryRaw,
    shop: { findUnique: vi.fn().mockResolvedValue({ status: shopStatus }) },
    billingPlan: { findUnique: vi.fn().mockResolvedValue(paidPlan) },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(billingPeriod),
      create: billingPeriodCreate,
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(periodCounter),
      create: periodCounterCreate,
    },
    shopEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(lifetimeCounter),
      create: lifetimeCounterCreate,
    },
    platformBillingPolicy: { findUnique: vi.fn().mockResolvedValue(policy) },
    subscription: { update: subscriptionUpdate },
  };
  const database = { $transaction: vi.fn() };
  const service = new SubscriptionActivationService(database as never, {} as never);
  const now = new Date("2026-09-14T00:00:00.000Z");
  const expected = {
    subscriptionId: "subscription-1",
    pendingPlanId: "paid-1",
    pendingShopifyPlanHandle: "growth",
    pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
    nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
    planKind: BillingPlanKind.PAID_METERED,
  };
  const providerSubscription = {
    provider: "SHOPIFY",
    planHandle: "growth",
    billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: { handle: "growth", description: null, price: { amount: "10", currency: "USD" } },
    pendingFlatRatePlan: null,
    usageItems: [],
    usageEventHandles: ["paid-meter"],
    pendingPlanHandle: null,
    pendingEffectiveAt: null,
    status: "ACTIVE",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-subscription-1",
    providerUsageSnapshot: [],
    ...providerOverrides,
  } as ProviderSubscription;
  const existingSubscription = {
    id: "subscription-1",
    planId: null,
    pendingPlanId: "paid-1",
    pendingShopifyPlanHandle: "growth",
  };
  const finalize = () => service.finalizeInitialPaidActivation({
    transaction: transaction as never,
    shopId: "shop-1",
    providerSubscription,
    expected,
    existingSubscription,
    now,
  });

  return {
    service,
    database,
    transaction,
    queryRaw,
    finalize,
    now,
    providerSubscription,
    billingPeriodCreate,
    periodCounterCreate,
    lifetimeCounterCreate,
    subscriptionUpdate,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SubscriptionActivationService", () => {
  it("prepares an initial Free selection and preserves the ShopSettings then Subscription lock order", async () => {
    const { service, state, subscription, transaction } = createHarness();

    const activation = await service.prepareFreeActivation("shop-1", "free");

    expect(activation).toMatchObject({ plan, mode: "INITIAL", token: { planKind: BillingPlanKind.FREE } });
    expect(Object.isFrozen(activation?.token)).toBe(true);
    expect(state.currentSubscription).toMatchObject({
      status: SubscriptionProjectionStatus.NO_CONTRACT,
      planId: null,
      pendingShopifyPlanHandle: "free",
      pendingPlanId: "free-1",
    });
    expect(subscription.upsert).toHaveBeenCalledTimes(1);
    const lockStatements = transaction.$queryRaw.mock.calls.map(([query]) => (query as { sql?: string }).sql);
    expect(lockStatements[0]).toContain('FROM "shopify"."ShopSettings"');
    expect(lockStatements[0]).toContain("FOR UPDATE");
    expect(lockStatements[1]).toContain('FROM "billing"."Subscription"');
    expect(lockStatements[1]).toContain("FOR UPDATE");
  });

  it("allows a verified Free replay without replacing the current selection", async () => {
    const existing = {
      id: "subscription-1",
      status: SubscriptionProjectionStatus.ACTIVE,
      planId: "free-1",
      observedShopifyPlanHandle: "free",
      pendingPlanId: "pending-1",
    };
    const { service, subscription } = createHarness({ currentSubscription: existing });

    await expect(service.prepareFreeActivation("shop-1", "free")).resolves.toEqual({
      plan,
      mode: "VERIFIED_REPLAY",
      token: null,
    });
    expect(subscription.upsert).not.toHaveBeenCalled();
  });

  it("records Paid activation intent without finalizing the subscription", async () => {
    const { service, state, subscription } = createHarness({ kind: BillingPlanKind.PAID_METERED });

    const activation = await service.preparePaidActivation("shop-1", "free");

    expect(activation).toMatchObject({ mode: "INITIAL", token: { planKind: BillingPlanKind.PAID_METERED } });
    expect(state.currentSubscription).toMatchObject({
      status: SubscriptionProjectionStatus.NO_CONTRACT,
      planId: null,
      pendingPlanId: "free-1",
      pendingShopifyPlanHandle: "free",
    });
    expect(subscription.upsert).toHaveBeenCalledTimes(1);
  });

  it("leaves a stale guarded retry as a no-op", async () => {
    const expected = {
      subscriptionId: "subscription-1",
      pendingPlanId: "free-1",
      pendingShopifyPlanHandle: "free",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
    };
    const { service, subscription } = createHarness({
      currentSubscription: {
        id: "subscription-1",
        ...expected,
        pendingPlanId: "newer-plan",
      },
    });

    await expect(service.scheduleInitialFreeReconciliationIfCurrent({
      shopId: "shop-1",
      expected,
      nextReconcileAt: new Date("2026-09-12T00:01:00.000Z"),
    })).resolves.toBeNull();
    expect(subscription.update).not.toHaveBeenCalled();
  });

  it("records a Partner-error retry only for the matching current token", async () => {
    const nextReconcileAt = new Date("2026-09-12T00:01:00.000Z");
    const partnerErrorAt = new Date("2026-09-12T00:00:30.000Z");
    const expected = {
      subscriptionId: "subscription-1",
      pendingPlanId: "free-1",
      pendingShopifyPlanHandle: "free",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
    };
    const { service, subscription } = createHarness({
      currentSubscription: { id: expected.subscriptionId, ...expected },
    });

    await expect(service.scheduleInitialFreeReconciliationIfCurrent({
      shopId: "shop-1",
      expected,
      nextReconcileAt,
      partnerErrorAt,
    })).resolves.toEqual({ subscriptionId: "subscription-1", nextReconcileAt });
    expect(subscription.update).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: {
        nextReconcileAt,
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: partnerErrorAt,
      },
      select: { id: true, nextReconcileAt: true },
    });
  });

  it("schedules Free completion at the existing drain-window boundary", async () => {
    const now = new Date("2026-09-14T00:00:00.000Z");
    const currentPeriodEnd = new Date("2026-10-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { service, subscription } = createHarness({
      topUpEnabled: true,
      currentSubscription: {
        id: "subscription-1",
        status: SubscriptionProjectionStatus.ACTIVE,
        planId: "free-1",
        observedShopifyPlanHandle: "free",
        pendingShopifyPlanHandle: "free",
        pendingPlanId: "free-1",
        pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
        currentPeriodEnd,
        plan,
      },
    });

    await expect(service.completeFreeActivation("shop-1", "free")).resolves.toEqual({
      subscriptionId: "subscription-1",
      nextReconcileAt: new Date(currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS),
    });
    expect(subscription.update).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: {
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
        nextReconcileAt: new Date(currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS),
      },
    });
  });

  it("finalizes initial Paid activation atomically in the supplied transaction and preserves lock order", async () => {
    const harness = createPaidFinalisationHarness();
    await lockInitialFreeActivationState(harness.transaction as never, "shop-1");

    const result = await harness.finalize();

    expect(result).toMatchObject({ id: "subscription-1", status: SubscriptionProjectionStatus.ACTIVE });
    expect(harness.database.$transaction).not.toHaveBeenCalled();
    expect(harness.billingPeriodCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        planId: "paid-1",
        planKindSnapshot: BillingPlanKind.PAID_METERED,
        includedRecoveryCreditsGranted: 25,
      }),
    });
    expect(harness.periodCounterCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ grantedQuantity: 25 }),
    });
    expect(harness.lifetimeCounterCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ grantedQuantity: 5 }),
    });
    expect(harness.subscriptionUpdate).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: expect.objectContaining({
        status: SubscriptionProjectionStatus.ACTIVE,
        pendingPlanId: null,
        nextReconcileAt: new Date("2026-09-30T23:55:00.000Z"),
      }),
    });
    const lockStatements = harness.queryRaw.mock.calls.map(([query]) => (query as { sql?: string }).sql);
    expect(lockStatements[0]).toContain('FROM "shopify"."ShopSettings"');
    expect(lockStatements[1]).toContain('FROM "billing"."Subscription"');
    expect(lockStatements[2]).toContain('FROM "shopify"."Shop"');
    expect(lockStatements[2]).toContain("FOR UPDATE");
  });

  it.each([
    ["inactive plan", { planOverrides: { active: false } }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["mismatched plan kind", { planOverrides: { kind: BillingPlanKind.FREE } }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["missing usage meter", { planOverrides: { shopifyUsageEventHandle: null } }, "MISSING_USAGE_METER"],
    ["unexposed usage meter", { providerOverrides: { usageEventHandles: [] } }, "MISSING_USAGE_METER"],
    ["invalid included allowance", { planOverrides: { includedRecoveryConversationAllowance: -1 } }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["missing provider cycle", { providerOverrides: { currentPeriodStart: null } }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["inactive Shop", { shopStatus: "SUSPENDED" }, "INVALID_PAID_PLAN_CONFIGURATION"],
  ] as const)("fails closed for %s", async (_label, options, errorCode) => {
    const harness = createPaidFinalisationHarness(
      options as Parameters<typeof createPaidFinalisationHarness>[0],
    );

    await harness.finalize();

    expect(harness.subscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: SubscriptionProjectionStatus.SYNC_ERROR,
        lastSyncErrorCode: errorCode,
        nextReconcileAt: null,
      }),
    }));
    expect(harness.billingPeriodCreate).not.toHaveBeenCalled();
    expect(harness.periodCounterCreate).not.toHaveBeenCalled();
    expect(harness.lifetimeCounterCreate).not.toHaveBeenCalled();
  });

  it("selects missing-meter error before unsupported Paid trial", async () => {
    const harness = createPaidFinalisationHarness({
      planOverrides: { shopifyUsageEventHandle: null },
      providerOverrides: {
        status: "TRIALING",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: new Date("2026-09-20T00:00:00.000Z"),
      },
    });

    await harness.finalize();

    expect(harness.subscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: "MISSING_USAGE_METER" }),
    }));
  });

  it("rejects unsupported Paid trial when the required usage meter is exposed", async () => {
    const harness = createPaidFinalisationHarness({
      providerOverrides: {
        status: "TRIALING",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: new Date("2026-09-20T00:00:00.000Z"),
      },
    });

    await harness.finalize();

    expect(harness.subscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: SubscriptionProjectionStatus.SYNC_ERROR,
        lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL",
        nextReconcileAt: null,
      }),
    }));
    expect(harness.billingPeriodCreate).not.toHaveBeenCalled();
    expect(harness.periodCounterCreate).not.toHaveBeenCalled();
    expect(harness.lifetimeCounterCreate).not.toHaveBeenCalled();
  });

  it("preserves existing period and entitlement counters on replay", async () => {
    const existingPeriod = {
      id: "period-1",
      status: "OPEN",
      subscriptionId: "subscription-1",
      planId: "paid-1",
      shopifyPlanHandleSnapshot: "growth",
      planNameSnapshot: "Growth",
      planKindSnapshot: BillingPlanKind.PAID_METERED,
      includedRecoveryCreditsGranted: 25,
    };
    const existingPeriodCounter = {
      shopId: "shop-1",
      billingPeriodId: "period-1",
      grantedQuantity: 25,
      committedQuantity: 7,
      reservedQuantity: 3,
    };
    const existingLifetimeCounter = {
      grantedQuantity: 5,
      committedQuantity: 4,
      reservedQuantity: 1,
      refundingQuantity: 0,
    };
    const harness = createPaidFinalisationHarness({
      billingPeriod: existingPeriod,
      periodCounter: existingPeriodCounter,
      lifetimeCounter: existingLifetimeCounter,
    });

    await harness.finalize();

    expect(harness.billingPeriodCreate).not.toHaveBeenCalled();
    expect(harness.periodCounterCreate).not.toHaveBeenCalled();
    expect(harness.lifetimeCounterCreate).not.toHaveBeenCalled();
    expect(existingPeriodCounter).toMatchObject({ committedQuantity: 7, reservedQuantity: 3 });
    expect(existingLifetimeCounter).toMatchObject({ committedQuantity: 4, reservedQuantity: 1 });
  });

  it("rejects closed periods, conflicting included grants, and invalid lifetime policy", async () => {
    const closedPeriod = createPaidFinalisationHarness({
      billingPeriod: {
        id: "period-1",
        status: "CLOSED",
        subscriptionId: "subscription-1",
        planId: "paid-1",
        shopifyPlanHandleSnapshot: "growth",
        planNameSnapshot: "Growth",
        planKindSnapshot: BillingPlanKind.PAID_METERED,
        includedRecoveryCreditsGranted: 25,
      },
    });
    await closedPeriod.finalize();
    expect(closedPeriod.subscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION" }),
    }));

    const conflictingCounter = createPaidFinalisationHarness({
      billingPeriod: {
        id: "period-1",
        status: "OPEN",
        subscriptionId: "subscription-1",
        planId: "paid-1",
        shopifyPlanHandleSnapshot: "growth",
        planNameSnapshot: "Growth",
        planKindSnapshot: BillingPlanKind.PAID_METERED,
        includedRecoveryCreditsGranted: 25,
      },
      periodCounter: { shopId: "shop-1", billingPeriodId: "period-1", grantedQuantity: 99 },
    });
    await conflictingCounter.finalize();
    expect(conflictingCounter.subscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION" }),
    }));

    const invalidPolicy = createPaidFinalisationHarness({ policy: { lifetimeFreeRecoveryAllowance: -1 } });
    await invalidPolicy.finalize();
    expect(invalidPolicy.subscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION" }),
    }));
  });
});