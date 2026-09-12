import { describe, expect, it, vi } from "vitest";
import {
  BILLING_SYSTEM_MESSAGE_CODES,
  createShopifyUsageIdempotencyKey,
} from "@modainteract/moda-interact-shared/billing";

import { BillingService } from "../../../app/services/billing/billing.service";
import { getMerchantSystemMessageAction } from "../../../app/services/merchant-support/system-message-actions";

const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");

function providerSubscription(overrides: Record<string, unknown> = {}) {
  return {
    provider: "SHOPIFY",
    planHandle: "growth",
    billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: {
      handle: "growth",
      description: "growth",
      price: { amount: "10", currency: "USD" },
    },
    pendingFlatRatePlan: null,
    usageItems: [],
    usageEventHandles: ["message-meter"],
    pendingPlanHandle: null,
    pendingEffectiveAt: null,
    status: "ACTIVE",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-1",
    providerUsageSnapshot: [],
    ...overrides,
  };
}

type BillingPlanFixture = Record<string, unknown>;

function createDatabase({
  plan = null,
  pendingPlan = null,
  current = null,
}: {
  plan?: BillingPlanFixture | null;
  pendingPlan?: BillingPlanFixture | null;
  current?: BillingPlanFixture | null;
} = {}) {
  const state: { current: BillingPlanFixture | null } = { current };
  const subscription = {
    findUnique: vi.fn().mockImplementation(async () => state.current),
    upsert: vi.fn().mockImplementation(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      state.current = { id: "subscription-1", ...(state.current ?? create), ...update };
      return state.current;
    }),
  };
  const billingPlan = {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { shopifyPlanHandle: string } }) => {
      if (where.shopifyPlanHandle === plan?.shopifyPlanHandle || (!plan?.shopifyPlanHandle && where.shopifyPlanHandle === "growth")) return plan;
      if (where.shopifyPlanHandle === "starter") return pendingPlan;
      return null;
    }),
  };
  const billingPeriod = {
    upsert: vi.fn().mockResolvedValue({ id: "period-1", periodStart, periodEnd }),
  };
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }) },
    subscription,
    billingPlan,
    billingPeriod,
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({ subscription, billingPlan, billingPeriod })),
  };
  return { database, state };
}

describe("BillingService subscription projection", () => {
  function createFreeActivationDatabase({
    currentSubscription = null,
    onboardingCompleted = false,
    lifetimeCounter = null,
    policy = { lifetimeFreeRecoveryAllowance: 5 },
    planOverrides = {},
  }: {
    currentSubscription?: Record<string, unknown> | null;
    onboardingCompleted?: boolean;
    lifetimeCounter?: Record<string, unknown> | null;
    policy?: Record<string, unknown> | null;
    planOverrides?: Record<string, unknown>;
  } = {}) {
    const freePlan = {
      id: "free-1",
      shopifyPlanHandle: "free",
      kind: "FREE",
      active: true,
      recoveryCreditPackEnabled: false,
      ...planOverrides,
    };
    const state = {
      currentSubscription,
      onboardingCompleted,
      lifetimeCounter,
    };
    const subscription = {
      findUnique: vi.fn().mockImplementation(async () => state.currentSubscription),
      upsert: vi.fn().mockImplementation(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
        state.currentSubscription = { id: "subscription-1", ...(state.currentSubscription ?? create), ...update };
        return state.currentSubscription;
      }),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        state.currentSubscription = { ...(state.currentSubscription ?? {}), ...data };
        return state.currentSubscription;
      }),
    };
    const shopSettings = {
      findUnique: vi.fn().mockResolvedValue({ onboardingCompleted }),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        state.onboardingCompleted = Boolean(data.onboardingCompleted);
        return { onboardingCompleted: state.onboardingCompleted };
      }),
    };
    const shopEntitlementCounter = {
      findUnique: vi.fn().mockImplementation(async () => state.lifetimeCounter),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        state.lifetimeCounter = { ...data };
        return state.lifetimeCounter;
      }),
    };
    const executeRaw = vi.fn().mockImplementation(async () => {
      if (!state.lifetimeCounter && policy && typeof policy.lifetimeFreeRecoveryAllowance === "number") {
        state.lifetimeCounter = {
          shopId: "shop-1",
          counter: "FREE_RECOVERY_LIFETIME",
          grantedQuantity: policy.lifetimeFreeRecoveryAllowance,
        };
      }
      return 1;
    });
    const database = {
      billingPlan: {
        findUnique: vi.fn().mockResolvedValue(freePlan),
      },
      subscription,
      shopSettings,
      shopEntitlementCounter,
      platformBillingPolicy: {
        findUnique: vi.fn().mockResolvedValue(policy),
      },
      $executeRaw: executeRaw,
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        subscription,
        shopSettings,
        shopEntitlementCounter,
        platformBillingPolicy: database.platformBillingPolicy,
        $executeRaw: executeRaw,
      })),
    };
    return { database, state, freePlan, shopSettings, shopEntitlementCounter, platformBillingPolicy: database.platformBillingPolicy, executeRaw };
  }

  it("records an initial Free selection without activating entitlement", async () => {
    const { database, state } = createFreeActivationDatabase({
      currentSubscription: {
        status: "NO_CONTRACT",
        planId: null,
        observedShopifyPlanHandle: null,
      },
    });
    const service = new BillingService({} as never, database as never);

    await service.prepareFreeActivation("shop-1", "free");

    expect(state.currentSubscription).toMatchObject({
      status: "NO_CONTRACT",
      planId: null,
      pendingShopifyPlanHandle: "free",
      pendingPlanId: "free-1",
      pendingEffectiveAt: expect.any(Date),
      nextReconcileAt: expect.any(Date),
    });
  });

  it("replaces an older unresolved Free selection with a newer valid selection", async () => {
    const { database, state } = createFreeActivationDatabase({
      currentSubscription: {
        status: "NO_CONTRACT",
        planId: null,
        observedShopifyPlanHandle: null,
        pendingShopifyPlanHandle: "free-a",
        pendingPlanId: "free-a-id",
      },
    });
    const service = new BillingService({} as never, database as never);

    await service.prepareFreeActivation("shop-1", "free");

    expect(state.currentSubscription).toMatchObject({
      pendingShopifyPlanHandle: "free",
      pendingPlanId: "free-1",
    });
  });

  it("accepts a fresh shop without a Subscription when onboarding is incomplete", async () => {
    const { database } = createFreeActivationDatabase({ onboardingCompleted: false });
    const service = new BillingService({} as never, database as never);

    await expect(service.prepareFreeActivation("shop-1", "free")).resolves.toBeTruthy();
  });

  it("rejects a shop without a Subscription when onboarding is already complete", async () => {
    const { database } = createFreeActivationDatabase({ onboardingCompleted: true });
    const service = new BillingService({} as never, database as never);

    await expect(service.prepareFreeActivation("shop-1", "free")).resolves.toBeNull();
    expect(database.subscription.upsert).not.toHaveBeenCalled();
  });

  it("does not overwrite an active different-plan subscription", async () => {
    const { database } = createFreeActivationDatabase({
      currentSubscription: {
        status: "ACTIVE",
        planId: "paid-1",
        observedShopifyPlanHandle: "paid",
      },
      onboardingCompleted: true,
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.prepareFreeActivation("shop-1", "free")).resolves.toBeNull();
    expect(database.subscription.upsert).not.toHaveBeenCalled();
  });

  it("allows verified same-Free replay without replacing entitlement quantities", async () => {
    const { database } = createFreeActivationDatabase({
      currentSubscription: {
        status: "ACTIVE",
        planId: "free-1",
        observedShopifyPlanHandle: "free",
      },
      onboardingCompleted: true,
      lifetimeCounter: {
        grantedQuantity: 5,
        committedQuantity: 3,
        reservedQuantity: 1,
      },
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.prepareFreeActivation("shop-1", "free")).resolves.toBeTruthy();
    expect(database.subscription.upsert).toHaveBeenCalledTimes(1);
  });

  it("snapshots the platform lifetime policy once and clears non-pack scheduling", async () => {
    const { database, state, shopSettings, executeRaw } = createFreeActivationDatabase({
      currentSubscription: {
        status: "ACTIVE",
        planId: "free-1",
        observedShopifyPlanHandle: "free",
        nextReconcileAt: new Date("2026-09-12T00:01:00.000Z"),
        plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
      },
    });
    database.subscription.findUnique.mockResolvedValue({
      ...state.currentSubscription,
      plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.completeFreeActivation("shop-1", "free")).resolves.toBe(true);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(shopSettings.update).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: { onboardingCompleted: true },
    });
    expect(database.subscription.update).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: expect.objectContaining({ nextReconcileAt: null }),
    });
  });

  it("preserves an existing lifetime counter on verified replay", async () => {
    const existingCounter = {
      grantedQuantity: 5,
      committedQuantity: 3,
      reservedQuantity: 1,
      forfeitedQuantity: 0,
    };
    const { database, shopEntitlementCounter, platformBillingPolicy, executeRaw } = createFreeActivationDatabase({
      currentSubscription: {
        status: "ACTIVE",
        planId: "free-1",
        observedShopifyPlanHandle: "free",
        nextReconcileAt: null,
        plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
      },
      lifetimeCounter: existingCounter,
    });
    database.subscription.findUnique.mockResolvedValue({
      status: "ACTIVE",
      planId: "free-1",
      observedShopifyPlanHandle: "free",
      nextReconcileAt: null,
      plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.completeFreeActivation("shop-1", "free")).resolves.toBe(true);

    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(platformBillingPolicy.findUnique).not.toHaveBeenCalled();
    expect(existingCounter).toEqual({
      grantedQuantity: 5,
      committedQuantity: 3,
      reservedQuantity: 1,
      forfeitedQuantity: 0,
    });
  });

  it("fails closed when the platform lifetime policy is missing", async () => {
    const { database, shopSettings, shopEntitlementCounter } = createFreeActivationDatabase({
      currentSubscription: {
        status: "ACTIVE",
        planId: "free-1",
        observedShopifyPlanHandle: "free",
        nextReconcileAt: null,
        plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
      },
      policy: null,
    });
    database.subscription.findUnique.mockResolvedValue({
      status: "ACTIVE",
      planId: "free-1",
      observedShopifyPlanHandle: "free",
      nextReconcileAt: null,
      plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.completeFreeActivation("shop-1", "free")).resolves.toBe(false);

    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(shopSettings.update).not.toHaveBeenCalled();
  });

  it("tolerates concurrent first Free activations racing to create the lifetime counter", async () => {
    const { database, state, shopEntitlementCounter } = createFreeActivationDatabase({
      currentSubscription: {
        status: "ACTIVE",
        planId: "free-1",
        observedShopifyPlanHandle: "free",
        nextReconcileAt: null,
        plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
      },
    });
    database.subscription.findUnique.mockImplementation(async () => ({
      ...state.currentSubscription,
      plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
    }));
    const service = new BillingService({} as never, database as never);

    await expect(Promise.all([
      service.completeFreeActivation("shop-1", "free"),
      service.completeFreeActivation("shop-1", "free"),
    ])).resolves.toEqual([true, true]);
    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(state.lifetimeCounter).toMatchObject({ grantedQuantity: 5 });
  });

  it("returns Shopify commercial facts and independent current/pending mappings", async () => {
    const { database } = createDatabase({
      plan: { id: "growth-1", name: "Growth", kind: "PAID_METERED" },
      pendingPlan: { id: "starter-1", name: "Starter", kind: "FREE" },
    });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
        currentFlatRatePlan: {
          handle: "growth",
          description: "Growth monthly",
          price: { amount: "19.00", currency: "GBP" },
        },
        pendingFlatRatePlan: {
          handle: "starter",
          price: { amount: "0.00", currency: "GBP" },
          effectiveAt: periodEnd,
        },
        billingPeriod: "ANNUAL",
        cancelAtPeriodEnd: true,
      })),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifySubscriptionState("shop-1")).resolves.toMatchObject({
      status: "ACTIVE_SUBSCRIPTION",
      subscription: {
        planHandle: "growth",
        description: "Growth monthly",
        price: { amount: "19.00", currency: "GBP" },
        billingPeriod: "ANNUAL",
        cancelAtEndOfCycle: true,
        pendingUpdate: {
          planHandle: "starter",
          price: { amount: "0.00", currency: "GBP" },
          effectiveAt: periodEnd.toISOString(),
        },
      },
      mappingStatus: "MAPPED",
      modaMapping: { id: "growth-1", name: "Growth", kind: "PAID_METERED" },
      pendingModaMapping: { id: "starter-1", name: "Starter", kind: "FREE" },
    });
    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
  });

  it("preserves a mapped Free subscription billing cycle and active usage items", async () => {
    const { database } = createDatabase({
      plan: { id: "free-1", name: "Free", kind: "FREE" },
    });
    const usageItem = {
      handle: "recovery-credit-pack",
      description: "Recovery credit pack",
      price: {
        kind: "TIERED" as const,
        active: true,
        currency: "GBP",
        tiersMode: "VOLUME",
        tiers: [{ upTo: null, amountPerUnit: "0.10", amount: "0.10" }],
      },
      usage: { quantity: 2, costAmount: "0.20", costCurrency: "GBP" },
    };
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
        currentFlatRatePlan: {
          handle: "growth",
          description: "Free",
          price: { amount: "0.00", currency: "GBP" },
        },
        usageItems: [usageItem],
      })),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifySubscriptionState("shop-1")).resolves.toMatchObject({
      subscription: {
        currentPeriodStart: periodStart.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
        price: { amount: "0.00", currency: "GBP" },
        usageItems: [usageItem],
      },
      modaMapping: { id: "free-1", name: "Free", kind: "FREE" },
    });
  });

  it("keeps an independently unmapped pending handle and propagates Partner failures", async () => {
    const { database } = createDatabase({
      plan: { id: "growth-1", name: "Growth", kind: "PAID_METERED" },
    });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
        pendingFlatRatePlan: {
          handle: "premium_2026",
          price: { amount: "99.00", currency: "GBP" },
          effectiveAt: periodEnd,
        },
      })),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifySubscriptionState("shop-1")).resolves.toMatchObject({
      mappingStatus: "MAPPED",
      modaMapping: { id: "growth-1" },
      pendingModaMapping: null,
    });

    provider.getActiveSubscription.mockRejectedValue(new Error("Partner unavailable"));
    await expect(service.getMerchantShopifySubscriptionState("shop-1"))
      .rejects.toThrow("Partner unavailable");
  });

  it("preserves an unmapped Shopify contract and returns no active state explicitly", async () => {
    const { database } = createDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
      planHandle: "premium_2026",
      currentFlatRatePlan: {
        handle: "premium_2026",
        description: "Premium",
        price: { amount: "99", currency: "GBP" },
      },
    })) };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifySubscriptionState("shop-1")).resolves.toMatchObject({
      status: "ACTIVE_SUBSCRIPTION",
      subscription: { planHandle: "premium_2026", price: { amount: "99", currency: "GBP" } },
      mappingStatus: "UNMAPPED",
      modaMapping: null,
    });

    provider.getActiveSubscription.mockResolvedValue(null);
    await expect(service.getMerchantShopifySubscriptionState("shop-1")).resolves.toEqual({
      status: "NO_ACTIVE_SUBSCRIPTION",
      subscription: null,
    });
  });

  it("persists the canonical subscription-ended code that maps to the billing CTA", async () => {
    const current = {
      status: "ACTIVE",
      observedShopifyPlanHandle: "growth",
      providerSubscriptionId: "provider-1",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
    };
    const subscription = {
      findUnique: vi.fn().mockResolvedValue(current),
      upsert: vi.fn().mockResolvedValue({}),
    };
    const persistenceQueryRaw = vi.fn()
      .mockResolvedValueOnce([{ defaultLanguageTag: "en-US" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "thread-1" }])
      .mockResolvedValueOnce([{ id: "message-1" }]);
    const persistenceTransaction = {
      $queryRaw: persistenceQueryRaw,
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }) },
      $transaction: vi.fn()
        .mockImplementationOnce(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
          subscription,
        }))
        .mockImplementationOnce(async (callback: (transaction: unknown) => Promise<unknown>) => callback(persistenceTransaction)),
    };
    const service = new BillingService(
      { getActiveSubscription: vi.fn().mockResolvedValue(null) },
      database as never,
    );

    await service.syncSubscription("shop-1");

    const messageInsert = persistenceQueryRaw.mock.calls[3][0];
    const persistedSystemCode = messageInsert.values.find(
      (value: unknown) => typeof value === "string" && value.startsWith("BILLING_"),
    );
    expect(persistedSystemCode).toBe(BILLING_SYSTEM_MESSAGE_CODES.SUBSCRIPTION_ENDED);
    expect(persistedSystemCode).toBe("BILLING_SUBSCRIPTION_ENDED");
    expect(getMerchantSystemMessageAction(persistedSystemCode)).toEqual({
      href: "/app/billing",
      labelKey: "billing.viewPlans",
    });
    expect(getMerchantSystemMessageAction("SUBSCRIPTION_ENDED")).toBeNull();
  });

  it("persists a mapped free plan without requiring a usage meter", async () => {
    const { database, state } = createDatabase({
      plan: { id: "free-1", shopifyPlanHandle: "growth", kind: "FREE", active: true, shopifyUsageEventHandle: null },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "ACTIVE", planId: "free-1", observedShopifyPlanHandle: "growth" });
    expect(database.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId_periodStart_periodEnd: { shopId: "shop-1", periodStart, periodEnd } },
      create: expect.objectContaining({
        planKindSnapshot: "FREE",
        includedRecoveryCreditsGranted: null,
      }),
    }));
  });

  it("schedules the next pre-close reconciliation for a pack-enabled Free cycle", async () => {
    const { database, state } = createDatabase({
      plan: {
        id: "free-1",
        shopifyPlanHandle: "growth",
        kind: "FREE",
        active: true,
        recoveryCreditPackEnabled: true,
      },
    });
    const service = new BillingService(
      { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) },
      database as never,
    );

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({
      nextReconcileAt: new Date(periodEnd.getTime() - 5 * 60 * 1000),
    });
  });

  it("keeps pack-enabled Free activation retryable when Shopify omits a cycle", async () => {
    const { database, state } = createDatabase({
      plan: {
        id: "free-1",
        shopifyPlanHandle: "growth",
        kind: "FREE",
        active: true,
        recoveryCreditPackEnabled: true,
      },
    });
    const service = new BillingService(
      {
        getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
          currentPeriodStart: null,
          currentPeriodEnd: null,
        })),
      },
      database as never,
    );
    const before = Date.now();

    await service.syncSubscription("shop-1");

    const nextReconcileAt = state.current?.nextReconcileAt;
    expect(nextReconcileAt).toBeInstanceOf(Date);
    if (!(nextReconcileAt instanceof Date)) throw new Error("Expected a retry schedule.");
    expect(nextReconcileAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("fails closed when a paid plan omits its configured usage meter", async () => {
    const { database, state } = createDatabase({
      plan: { id: "paid-1", shopifyPlanHandle: "growth", kind: "PAID_METERED", active: true, shopifyUsageEventHandle: "message-meter" },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: [] })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "SYNC_ERROR", lastSyncErrorCode: "MISSING_USAGE_METER" });
  });

  it("persists a mapped paid plan and clears stale sync errors", async () => {
    const { database, state } = createDatabase({
      current: { id: "subscription-1", shopId: "shop-1", status: "SYNC_ERROR", lastSyncErrorCode: "MISSING_USAGE_METER" },
      plan: { id: "paid-1", shopifyPlanHandle: "growth", kind: "PAID_METERED", active: true, shopifyUsageEventHandle: "message-meter" },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ status: "TRIALING" })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({
      status: "TRIALING",
      planId: "paid-1",
      observedShopifyPlanHandle: "growth",
      billingPeriodId: "period-1",
      lastSyncErrorCode: null,
      lastSyncErrorAt: null,
    });
    expect(database.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "OPEN" }),
    }));
  });

  it("treats an inactive mapped plan as unmapped", async () => {
    const { database, state } = createDatabase({
      plan: { id: "growth-1", shopifyPlanHandle: "growth", kind: "FREE", active: false },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "UNMAPPED", planId: null, lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE" });
  });

  it("persists an unknown current Shopify handle as unmapped", async () => {
    const { database, state } = createDatabase();
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ planHandle: "unknown" })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "UNMAPPED", planId: null, observedShopifyPlanHandle: "unknown", lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE" });
  });

  it("maps a pending plan and stores the current cycle end as its effective boundary", async () => {
    const { database, state } = createDatabase({
      plan: { id: "growth-1", shopifyPlanHandle: "growth", kind: "FREE", active: true },
      pendingPlan: { id: "starter-1", shopifyPlanHandle: "starter", active: true },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ pendingPlanHandle: "starter", pendingEffectiveAt: periodEnd })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ pendingShopifyPlanHandle: "starter", pendingPlanId: "starter-1", pendingEffectiveAt: periodEnd });
  });

  it("stores an unknown pending handle without inventing a pending plan id", async () => {
    const { database, state } = createDatabase({
      plan: { id: "growth-1", shopifyPlanHandle: "growth", kind: "FREE", active: true },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ pendingPlanHandle: "unknown-pending" })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ pendingShopifyPlanHandle: "unknown-pending", pendingPlanId: null });
  });

  it("preserves a fresh Free activation intent when Shopify has no active subscription", async () => {
    const { database, state } = createDatabase({
      current: {
        status: "NO_CONTRACT",
        pendingShopifyPlanHandle: "free",
        pendingPlanId: "free-1",
        pendingEffectiveAt: new Date("2026-01-01T00:00:00.000Z"),
        nextReconcileAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(null) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({
      status: "NO_CONTRACT",
      pendingShopifyPlanHandle: "free",
      pendingPlanId: "free-1",
      nextReconcileAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("preserves newer Free-B intent when an older Free-A sync sees only Free-A", async () => {
    const pendingEffectiveAt = new Date("2026-09-12T00:02:00.000Z");
    const nextReconcileAt = new Date("2026-09-12T00:03:00.000Z");
    const { database, state } = createDatabase({
      plan: {
        id: "free-a-id",
        shopifyPlanHandle: "free-a",
        name: "Free A",
        kind: "FREE",
        active: true,
        recoveryCreditPackEnabled: false,
      },
      current: {
        id: "subscription-1",
        status: "NO_CONTRACT",
        pendingShopifyPlanHandle: "free-b",
        pendingPlanId: "free-b-id",
        pendingEffectiveAt,
        nextReconcileAt,
      },
    });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
        planHandle: "free-a",
        currentFlatRatePlan: { handle: "free-a", description: "Free A", price: { amount: "0", currency: "USD" } },
        currentPeriodStart: null,
        currentPeriodEnd: null,
      })),
    };
    const service = new BillingService(provider, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({
      pendingShopifyPlanHandle: "free-b",
      pendingPlanId: "free-b-id",
      pendingEffectiveAt,
      nextReconcileAt,
    });
  });

  it("projects trial status and leaves period fields null when Shopify omits the cycle", async () => {
    const { database, state } = createDatabase({
      plan: { id: "free-1", shopifyPlanHandle: "growth", kind: "FREE", active: true },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ status: "TRIALING", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: new Date("2026-09-15T00:00:00.000Z") })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "TRIALING", trialEndsAt: new Date("2026-09-15T00:00:00.000Z"), billingPeriodId: null });
    expect(database.billingPeriod.upsert).not.toHaveBeenCalled();
  });

  it("projects no contract and clears current and pending plan state", async () => {
    const { database, state } = createDatabase({
      current: { id: "subscription-1", shopId: "shop-1", status: "ACTIVE", observedShopifyPlanHandle: "growth", providerSubscriptionId: "provider-1" },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(null) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingPlanId: null, pendingShopifyPlanHandle: null });
  });

  it("clears a stale sync error after a valid projection", async () => {
    const { database, state } = createDatabase({
      current: { id: "subscription-1", shopId: "shop-1", status: "SYNC_ERROR", lastSyncErrorCode: "MISSING_USAGE_METER" },
      plan: { id: "growth-1", shopifyPlanHandle: "growth", kind: "FREE", active: true },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "ACTIVE", lastSyncErrorCode: null, lastSyncErrorAt: null });
  });
});

function createRecoveryCreditPurchaseDatabase(planOverrides: Record<string, unknown> = {}) {
  const purchases = new Map<string, Record<string, unknown>>();
  const usageEvents: Record<string, unknown>[] = [];
  const shopEntitlementCounter = {
    update: vi.fn(),
    upsert: vi.fn(),
  };
  const plan = {
    id: "growth-1",
    shopifyPlanHandle: "growth",
    kind: "PAID_METERED",
    active: true,
    recoveryCreditPackEnabled: true,
    recoveryCreditsPerPack: 100,
    shopifyRecoveryCreditPackEventHandle: "credit-pack-meter",
    shopifyUsageEventHandle: "message-meter",
    ...planOverrides,
  };
  const subscriptionState = {
    status: "ACTIVE",
    billingPeriodId: "period-1",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    billingPeriod: { id: "period-1", periodStart, periodEnd },
    plan,
  };
  const transactionSubscription = { ...subscriptionState };
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }) },
    subscription: {
      findUnique: vi.fn().mockResolvedValue(subscriptionState),
    },
    recoveryCreditPurchase: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => purchases.get(where.id) ?? null),
    },
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      subscription: {
        findUnique: vi.fn().mockResolvedValue(transactionSubscription),
      },
      recoveryCreditPurchase: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => purchases.get(where.id) ?? null),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          const purchase = { ...data, status: "PENDING_BILLING", usageEvent: usageEvents.at(-1) };
          purchases.set(String(data.id), purchase);
          return purchase;
        }),
      },
      usageEvent: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          usageEvents.push(data);
          return data;
        }),
      },
      shopEntitlementCounter,
    })),
  };
  return { database, purchases, usageEvents, shopEntitlementCounter, subscriptionState, transactionSubscription };
}

describe("BillingService recovery credit packs", () => {
  it.each([
    ["FREE", { kind: "FREE", shopifyUsageEventHandle: null }],
    ["PAID_METERED", { kind: "PAID_METERED" }],
  ])("creates a pending pack request for a mapped %s plan", async (_name, planOverrides) => {
    const { database, usageEvents, shopEntitlementCounter } = createRecoveryCreditPurchaseDatabase(planOverrides);
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);

    const purchase = await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "11111111-1111-4111-8111-111111111111");

    expect(purchase).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", creditsGranted: 100, status: "PENDING_BILLING" });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      id: expect.any(String),
      metric: "RECOVERY_CREDIT_PACK_PURCHASE",
      quantity: 1,
      shopifyReportState: "PENDING",
      shopifyEventHandle: "credit-pack-meter",
      billingPeriodId: "period-1",
      shopifyIdempotencyKey: expect.any(String),
    });
    expect(usageEvents[0].shopifyIdempotencyKey).toBe(
      createShopifyUsageIdempotencyKey("shop-1", String(usageEvents[0].id)),
    );
    expect(shopEntitlementCounter.update).not.toHaveBeenCalled();
    expect(shopEntitlementCounter.upsert).not.toHaveBeenCalled();
  });

  it("returns the existing purchase without creating another usage event", async () => {
    const { database, purchases, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);
    const purchaseId = "22222222-2222-4222-8222-222222222222";

    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", purchaseId);
    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", purchaseId);

    expect(purchases).toHaveLength(1);
    expect(usageEvents).toHaveLength(1);
  });

  it("allows repeated purchases with different purchase IDs", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);

    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "33333333-3333-4333-8333-333333333333");
    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "44444444-4444-4444-8444-444444444444");

    expect(usageEvents).toHaveLength(2);
  });

  it("fails closed without creating an event when the pack meter is not verified", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter"] })) };
    const service = new BillingService(provider, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "55555555-5555-4555-8555-555555555555"))
      .rejects.toThrow("could not be verified");
    expect(usageEvents).toHaveLength(0);
  });

  it("fails closed when billingPeriodId is null", async () => {
    const { database, purchases, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const plan = (await database.subscription.findUnique({ where: { shopId: "shop-1" } })).plan;
    database.subscription.findUnique.mockResolvedValue({
      status: "ACTIVE",
      billingPeriodId: null,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      billingPeriod: { id: "period-1", periodStart, periodEnd },
      plan,
    });
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "12121212-1212-4121-8121-121212121212"))
      .rejects.toThrow("current local billing cycle");
    expect(usageEvents).toHaveLength(0);
    expect(purchases).toHaveLength(0);
  });

  it("rejects a missing local period boundary before contacting Shopify", async () => {
    const { database, purchases, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const subscription = await database.subscription.findUnique({ where: { shopId: "shop-1" } });
    database.subscription.findUnique.mockResolvedValue({ ...subscription, currentPeriodEnd: null });
    const provider = { getActiveSubscription: vi.fn() };
    const service = new BillingService(provider, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "13131313-1313-4131-8131-131313131313"))
      .rejects.toThrow("current local billing cycle");
    expect(provider.getActiveSubscription).not.toHaveBeenCalled();
    expect(usageEvents).toHaveLength(0);
    expect(purchases).toHaveLength(0);
  });

  it.each([
    ["provider cycle is missing", { currentPeriodStart: null, currentPeriodEnd: null }],
    ["provider cycle does not match", { currentPeriodStart: new Date("2026-09-02T00:00:00.000Z") }],
  ])("rejects when %s", async (_name, providerOverrides) => {
    const { database, purchases, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(
        providerSubscription({
          usageEventHandles: ["message-meter", "credit-pack-meter"],
          ...providerOverrides,
        }),
      ),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "14141414-1414-4141-8141-141414141414"))
      .rejects.toThrow("current Shopify billing cycle");
    expect(usageEvents).toHaveLength(0);
    expect(purchases).toHaveLength(0);
  });

  it("rejects client-supplied invalid purchase identities before persistence", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const service = new BillingService({ getActiveSubscription: vi.fn() }, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "not-a-uuid"))
      .rejects.toThrow("valid recovery credit purchase ID");
    expect(usageEvents).toHaveLength(0);
  });

  it("replays an existing purchase without provider availability", async () => {
    const { database, purchases, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);
    const purchaseId = "66666666-6666-4666-8666-666666666666";

    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", purchaseId);
    provider.getActiveSubscription.mockRejectedValue(new Error("Shopify unavailable"));

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", purchaseId))
      .resolves.toMatchObject({ id: purchaseId });
    expect(usageEvents).toHaveLength(1);
    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
    expect(purchases).toHaveLength(1);
  });

  it("fails closed when the durable configuration changes after provider verification", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const plan = (await database.subscription.findUnique({ where: { shopId: "shop-1" } })).plan;
    const provider = {
      getActiveSubscription: vi.fn().mockImplementation(async () => {
        plan.recoveryCreditsPerPack = 200;
        return providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] });
      }),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "77777777-7777-4777-8777-777777777777"))
      .rejects.toThrow("configuration changed");
    expect(usageEvents).toHaveLength(0);
  });

  it.each([
    ["billing period identity", { billingPeriodId: "period-2", billingPeriod: { id: "period-2", periodStart, periodEnd } }],
    ["billing period boundary", { currentPeriodEnd: new Date("2026-10-02T00:00:00.000Z"), billingPeriod: { id: "period-1", periodStart, periodEnd: new Date("2026-10-02T00:00:00.000Z") } }],
  ])("fails closed when the transaction re-read changes the %s", async (_name, transactionOverrides) => {
    const { database, purchases, usageEvents, transactionSubscription } = createRecoveryCreditPurchaseDatabase();
    Object.assign(transactionSubscription, transactionOverrides);
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "15151515-1515-4151-8151-151515151515"))
      .rejects.toThrow("configuration changed");
    expect(usageEvents).toHaveLength(0);
    expect(purchases).toHaveLength(0);
  });

  it.each([
    ["disabled", { recoveryCreditPackEnabled: false }],
    ["missing meter", { shopifyRecoveryCreditPackEventHandle: "   " }],
    ["unmapped", { active: false }],
  ])("creates no usage event for %s top-ups", async (_name, planOverrides) => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase(planOverrides);
    const service = new BillingService({ getActiveSubscription: vi.fn() }, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "88888888-8888-4888-8888-888888888888"))
      .rejects.toThrow();
    expect(usageEvents).toHaveLength(0);
  });

  it("ignores client-supplied plan and pricing fields", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);

    await (service.requestRecoveryCreditPack as unknown as (...args: unknown[]) => Promise<unknown>)(
      "shop-1",
      "BUY_RECOVERY_CREDIT_PACK",
      "99999999-9999-4999-8999-999999999999",
      { creditsGranted: 1, planId: "attacker-plan", meter: "attacker-meter", price: "0" },
    );

    expect(usageEvents[0]).toMatchObject({
      shopId: "shop-1",
      shopifyEventHandle: "credit-pack-meter",
      quantity: 1,
    });
  });

  it("creates no usage event for an unsafe subscription projection", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const current = await database.subscription.findUnique({ where: { shopId: "shop-1" } });
    database.subscription.findUnique.mockResolvedValue({
      ...current,
      status: "UNMAPPED",
    });
    const service = new BillingService({ getActiveSubscription: vi.fn() }, database as never);

    await expect(
      service.requestRecoveryCreditPack(
        "shop-1",
        "BUY_RECOVERY_CREDIT_PACK",
        "abababab-abab-4bab-8bab-abababababab",
      ),
    ).rejects.toThrow("unavailable for this subscription");
    expect(usageEvents).toHaveLength(0);
  });

  it("recovers a concurrent same-id unique conflict by returning the committed purchase", async () => {
    const { database, purchases, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(
        providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] }),
      ),
    };
    const purchaseId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const winningUsageEvent = {
      id: "winner-usage-event",
      shopId: "shop-1",
      metric: "RECOVERY_CREDIT_PACK_PURCHASE",
      quantity: 1,
      shopifyReportState: "PENDING",
      shopifyEventHandle: "credit-pack-meter",
    };
    const winningPurchase = {
      id: purchaseId,
      shopId: "shop-1",
      status: "PENDING_BILLING",
      creditsGranted: 100,
      usageEvent: winningUsageEvent,
    };

    database.$transaction = vi.fn(async () => {
      usageEvents.push(winningUsageEvent);
      purchases.set(purchaseId, winningPurchase);
      throw { code: "P2002" };
    });

    const service = new BillingService(provider, database as never);

    await expect(
      service.requestRecoveryCreditPack(
        "shop-1",
        "BUY_RECOVERY_CREDIT_PACK",
        purchaseId,
      ),
    ).resolves.toMatchObject({
      id: purchaseId,
      shopId: "shop-1",
      status: "PENDING_BILLING",
    });

    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
    expect(usageEvents).toHaveLength(1);
    expect(purchases).toHaveLength(1);
  });

  it("verifies Shopify before opening the Prisma write transaction", async () => {
    const { database } = createRecoveryCreditPurchaseDatabase();
    const events: string[] = [];
    const originalTransaction = database.$transaction;
    database.$transaction = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
      events.push("transaction");
      return originalTransaction(callback);
    });
    const provider = { getActiveSubscription: vi.fn().mockImplementation(async () => {
      events.push("provider");
      return providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] });
    }) };
    const service = new BillingService(provider, database as never);

    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    expect(events).toEqual(["provider", "transaction"]);
  });
});
