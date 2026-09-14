import { describe, expect, it, vi } from "vitest";
import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
  BILLING_SYSTEM_MESSAGE_CODES,
  createShopifyUsageIdempotencyKey,
} from "@modainteract/moda-interact-shared/billing";

import { BillingService } from "../../../app/services/billing/billing.service";
import { deriveBillingPeriodPhase } from "../../../app/services/billing/billing.service";
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
    update: vi.fn(),
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
  const shopSettings = {
    findUnique: vi.fn().mockResolvedValue({ onboardingCompleted: false }),
  };
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }) },
    subscription,
    billingPlan,
    billingPeriod,
    shopSettings,
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({ subscription, billingPlan, billingPeriod, shopSettings, $queryRaw: database.$queryRaw })),
  };
  return { database, state };
}

function createPaidActivationDatabase(overrides: Record<string, unknown> = {}) {
  const plan = {
    id: "paid-1",
    name: "Growth",
    kind: "PAID_METERED",
    shopifyPlanHandle: "growth",
    shopifyUsageEventHandle: "message-meter",
    active: true,
    includedRecoveryConversationAllowance: 25,
    ...overrides,
  };
  const periodStart = new Date("2026-09-01T00:00:00.000Z");
  const periodEnd = new Date("2026-10-01T00:00:00.000Z");
  const state = {
    shopStatus: "ACTIVE",
    onboardingCompleted: false,
    subscription: {
      id: "subscription-1",
      shopId: "shop-1",
      status: "ACTIVE",
      planId: "paid-1",
      plan,
      observedShopifyPlanHandle: "growth",
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
      billingPeriod: null as Record<string, unknown> | null,
    },
    periodCounter: null as Record<string, unknown> | null,
    lifetimeCounter: null as Record<string, unknown> | null,
  };
  const subscription = {
    findUnique: vi.fn().mockImplementation(async () => state.subscription),
    upsert: vi.fn().mockImplementation(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      state.subscription = { ...state.subscription, ...create, ...update };
      return state.subscription;
    }),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.subscription = { ...state.subscription, ...data };
      return state.subscription;
    }),
  };
  const billingPeriod = {
    findUnique: vi.fn().mockImplementation(async () => state.subscription.billingPeriod),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.subscription.billingPeriod = { id: "period-1", ...data };
      return state.subscription.billingPeriod;
    }),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.subscription.billingPeriod = { ...state.subscription.billingPeriod, ...data };
      return state.subscription.billingPeriod;
    }),
  };
  const billingPeriodEntitlementCounter = {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.periodCounter = { id: "counter-1", ...data };
      return state.periodCounter;
    }),
  };
  const shopEntitlementCounter = {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.lifetimeCounter = { id: "lifetime-1", ...data };
      return state.lifetimeCounter;
    }),
  };
  const shopSettings = {
    findUnique: vi.fn().mockResolvedValue({ onboardingCompleted: false }),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.onboardingCompleted = Boolean(data.onboardingCompleted);
      return { onboardingCompleted: state.onboardingCompleted };
    }),
  };
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    shop: { findUnique: vi.fn().mockImplementation(async () => ({ status: state.shopStatus })) },
    subscription,
    shopSettings,
    billingPlan: { findUnique: vi.fn().mockResolvedValue(plan) },
    billingPeriod,
    billingPeriodEntitlementCounter,
    shopEntitlementCounter,
    platformBillingPolicy: { findUnique: vi.fn().mockResolvedValue({ lifetimeFreeRecoveryAllowance: 5 }) },
  };
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }) },
    billingPlan: transaction.billingPlan,
    $queryRaw: transaction.$queryRaw,
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  return { database, state, billingPeriod, billingPeriodEntitlementCounter, shopEntitlementCounter };
}

describe("BillingService subscription projection", () => {
  it("records a paid first-selection intent without activating it", async () => {
    const { database, state } = createPaidActivationDatabase();
    state.subscription.status = "NO_CONTRACT";
    Object.assign(state.subscription, {
      planId: null,
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: null,
      pendingPlanId: null,
    });
    const service = new BillingService({} as never, database as never);

    const result = await service.preparePaidActivation("shop-1", "growth");

    expect(result).toMatchObject({ mode: "INITIAL", plan: { kind: "PAID_METERED" } });
    expect(state.subscription).toMatchObject({ pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1" });
    expect(state.onboardingCompleted).toBe(false);
  });

  it("creates the exact paid period and included counter in the verified sync transaction", async () => {
    const { database, state, billingPeriodEntitlementCounter, shopEntitlementCounter } = createPaidActivationDatabase();
    Object.assign(state.subscription, {
      status: "NO_CONTRACT",
      planId: null,
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await expect(service.syncSubscription("shop-1", {
      subscriptionId: "subscription-1",
      pendingPlanId: "paid-1",
      pendingShopifyPlanHandle: "growth",
      pendingEffectiveAt: state.subscription.pendingEffectiveAt,
      nextReconcileAt: state.subscription.nextReconcileAt,
      planKind: "PAID_METERED",
    })).resolves.toMatchObject({ id: "subscription-1", status: "ACTIVE" });

    expect(state.subscription.billingPeriod).toMatchObject({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      planId: "paid-1",
      shopifyPlanHandleSnapshot: "growth",
      planNameSnapshot: "Growth",
      planKindSnapshot: "PAID_METERED",
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      includedRecoveryCreditsGranted: 25,
      status: "OPEN",
    });
    expect(billingPeriodEntitlementCounter.create).toHaveBeenCalledWith({ data: expect.objectContaining({ grantedQuantity: 25 }) });
    expect(shopEntitlementCounter.create).toHaveBeenCalledWith({ data: expect.objectContaining({ grantedQuantity: 5 }) });
    expect(state.onboardingCompleted).toBe(true);
  });

  it.each([
    ["inactive", { active: false }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["wrong kind", { kind: "FREE" }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["changed handle", { shopifyPlanHandle: "other" }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["missing meter", { shopifyUsageEventHandle: null }, "MISSING_USAGE_METER"],
    ["unexposed meter", { shopifyUsageEventHandle: "other-meter" }, "MISSING_USAGE_METER"],
    ["null allowance", { includedRecoveryConversationAllowance: null }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["negative allowance", { includedRecoveryConversationAllowance: -1 }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["fractional allowance", { includedRecoveryConversationAllowance: 1.5 }, "INVALID_PAID_PLAN_CONFIGURATION"],
    ["unsafe allowance", { includedRecoveryConversationAllowance: Number.MAX_SAFE_INTEGER + 1 }, "INVALID_PAID_PLAN_CONFIGURATION"],
  ] as const)("transactionally revalidates the pending Paid plan for %s", async (_name, planOverride, errorCode) => {
    const { database, state, billingPeriod, billingPeriodEntitlementCounter, shopEntitlementCounter } = createPaidActivationDatabase(planOverride);
    Object.assign(state.subscription, {
      status: "NO_CONTRACT",
      planId: null,
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    const result = await service.syncSubscription("shop-1", {
      subscriptionId: "subscription-1",
      pendingPlanId: "paid-1",
      pendingShopifyPlanHandle: "growth",
      pendingEffectiveAt: state.subscription.pendingEffectiveAt,
      nextReconcileAt: state.subscription.nextReconcileAt,
      planKind: "PAID_METERED",
    });

    expect(result).toMatchObject({ status: "SYNC_ERROR", lastSyncErrorCode: errorCode, nextReconcileAt: null });
    expect(state.onboardingCompleted).toBe(false);
    expect(state.subscription).toMatchObject({ pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth" });
    expect(billingPeriod.create).not.toHaveBeenCalled();
    expect(billingPeriod.update).not.toHaveBeenCalled();
    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
  });

  it("locks and rereads the Shop before accepting initial Paid status", async () => {
    const { database, state } = createPaidActivationDatabase();
    Object.assign(state.subscription, {
      status: "NO_CONTRACT",
      planId: null,
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
    });
    const lockSql: string[] = [];
    database.$queryRaw.mockImplementation(async (query: { sql?: string }) => {
      lockSql.push(query.sql ?? "");
      return [];
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await service.syncSubscription("shop-1", {
      subscriptionId: "subscription-1",
      pendingPlanId: "paid-1",
      pendingShopifyPlanHandle: "growth",
      pendingEffectiveAt: state.subscription.pendingEffectiveAt,
      nextReconcileAt: state.subscription.nextReconcileAt,
      planKind: "PAID_METERED",
    });

    expect(lockSql[0]).toContain('FROM "shopify"."ShopSettings"');
    expect(lockSql[1]).toContain('FROM "billing"."Subscription"');
    expect(lockSql[2]).toContain('FROM "shopify"."Shop"');
    expect(lockSql[2]).toContain("FOR UPDATE");
  });

  it("fails closed when the current cycle is missing", async () => {
    const { database, state } = createPaidActivationDatabase();
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ currentPeriodStart: null })) }, database as never);

    await expect(service.syncSubscription("shop-1", { subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth", pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED" })).resolves.toMatchObject({ lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION" });
    expect(state.onboardingCompleted).toBe(false);
  });

  it("fails closed for an invalid included allowance", async () => {
    const { database, state } = createPaidActivationDatabase({ includedRecoveryConversationAllowance: -1 });
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await expect(service.syncSubscription("shop-1", { subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth", pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED" })).resolves.toMatchObject({ lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION" });
    expect(state.onboardingCompleted).toBe(false);
  });

  it("fails closed for a paid trial", async () => {
    const { database, state, billingPeriodEntitlementCounter } = createPaidActivationDatabase();
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ status: "TRIALING", trialEndsAt: new Date("2026-09-20T00:00:00.000Z"), currentPeriodStart: null, currentPeriodEnd: null })) }, database as never);

    await expect(service.syncSubscription("shop-1", { subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth", pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED" })).resolves.toMatchObject({ status: "SYNC_ERROR", lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL", nextReconcileAt: null });
    expect(state.onboardingCompleted).toBe(false);
    expect(state.subscription.pendingPlanId).toBe("paid-1");
    expect(state.subscription.pendingShopifyPlanHandle).toBe("growth");
    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
  });

  it("fails closed when the initial Paid target has no provider usage meter", async () => {
    const { database, state, billingPeriodEntitlementCounter, shopEntitlementCounter } = createPaidActivationDatabase({ shopifyUsageEventHandle: null });
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await expect(service.syncSubscription("shop-1", { subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth", pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED" })).resolves.toMatchObject({ lastSyncErrorCode: "MISSING_USAGE_METER", nextReconcileAt: null });
    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(state.onboardingCompleted).toBe(false);
  });

  it.each(["UNINSTALLED", "SUSPENDED"] as const)("does not activate when the Shop becomes %s before commit", async (shopStatus) => {
    const { database, state, billingPeriodEntitlementCounter } = createPaidActivationDatabase();
    state.shopStatus = shopStatus;
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await expect(service.syncSubscription("shop-1", { subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth", pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED" })).resolves.toMatchObject({ lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION", nextReconcileAt: null });
    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(state.onboardingCompleted).toBe(false);
  });

  it("rejects a stale pending Paid identity without creating billing state", async () => {
    const { database, state, billingPeriodEntitlementCounter } = createPaidActivationDatabase();
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "old-growth", pendingPlanId: "paid-old", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ planHandle: "growth" })) }, database as never);

    await expect(service.syncSubscription("shop-1", { subscriptionId: "subscription-1", pendingPlanId: "paid-old", pendingShopifyPlanHandle: "old-growth", pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED" })).resolves.not.toMatchObject({ planId: "paid-old", billingPeriodId: expect.any(String) });
    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(state.onboardingCompleted).toBe(false);
  });

  it("preserves replayed period and lifetime quantities", async () => {
    const { database, state, billingPeriodEntitlementCounter, shopEntitlementCounter } = createPaidActivationDatabase();
    state.subscription.billingPeriod = {
      id: "period-1", shopId: "shop-1", subscriptionId: "subscription-1", planId: "paid-1",
      periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      status: "OPEN", shopifyPlanHandleSnapshot: "growth", planNameSnapshot: "Growth", planKindSnapshot: "PAID_METERED", includedRecoveryCreditsGranted: 25,
    };
    state.periodCounter = { id: "counter-1", shopId: "shop-1", billingPeriodId: "period-1", grantedQuantity: 25, committedQuantity: 4, reservedQuantity: 3, forfeitedQuantity: 2 };
    state.lifetimeCounter = { id: "lifetime-1", grantedQuantity: 5, committedQuantity: 2, reservedQuantity: 1, refundingQuantity: 1 };
    billingPeriodEntitlementCounter.findUnique.mockResolvedValue(state.periodCounter);
    shopEntitlementCounter.findUnique.mockResolvedValue(state.lifetimeCounter);
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);
    await service.syncSubscription("shop-1", { subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth", pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED" });

    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(state.periodCounter).toMatchObject({ grantedQuantity: 25, committedQuantity: 4, reservedQuantity: 3, forfeitedQuantity: 2 });
    expect(state.lifetimeCounter).toMatchObject({ grantedQuantity: 5, committedQuantity: 2, reservedQuantity: 1, refundingQuantity: 1 });
  });

  it("fails closed without reopening a closed exact period", async () => {
    const { database, state, billingPeriod, billingPeriodEntitlementCounter, shopEntitlementCounter } = createPaidActivationDatabase();
    state.subscription.billingPeriod = {
      id: "period-1", shopId: "shop-1", subscriptionId: "subscription-1", planId: "paid-1",
      periodStart, periodEnd, status: "CLOSED", shopifyPlanHandleSnapshot: "growth", planNameSnapshot: "Growth",
      planKindSnapshot: "PAID_METERED", includedRecoveryCreditsGranted: 25,
    };
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await expect(service.syncSubscription("shop-1", {
      subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth",
      pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED",
    })).resolves.toMatchObject({ status: "SYNC_ERROR", lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION", nextReconcileAt: null });
    expect(state.subscription.billingPeriod).toMatchObject({ status: "CLOSED" });
    expect(billingPeriod.create).not.toHaveBeenCalled();
    expect(billingPeriod.update).not.toHaveBeenCalled();
    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
  });

  it("fails closed without overwriting a conflicting included counter grant", async () => {
    const { database, state, billingPeriodEntitlementCounter, shopEntitlementCounter } = createPaidActivationDatabase();
    state.subscription.billingPeriod = {
      id: "period-1", shopId: "shop-1", subscriptionId: "subscription-1", planId: "paid-1",
      periodStart, periodEnd, status: "OPEN", shopifyPlanHandleSnapshot: "growth", planNameSnapshot: "Growth",
      planKindSnapshot: "PAID_METERED", includedRecoveryCreditsGranted: 25,
    };
    const conflictingCounter = { id: "counter-1", shopId: "shop-1", billingPeriodId: "period-1", grantedQuantity: 99, committedQuantity: 4, reservedQuantity: 3, forfeitedQuantity: 2 };
    billingPeriodEntitlementCounter.findUnique.mockResolvedValue(conflictingCounter);
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date(), nextReconcileAt: new Date() });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await expect(service.syncSubscription("shop-1", {
      subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth",
      pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED",
    })).resolves.toMatchObject({ status: "SYNC_ERROR", lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION" });
    expect(conflictingCounter).toMatchObject({ grantedQuantity: 99, committedQuantity: 4, reservedQuantity: 3, forfeitedQuantity: 2 });
    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(state.onboardingCompleted).toBe(false);
  });

  it("stores the exact drain-window schedule on successful first Paid activation", async () => {
    const { database, state } = createPaidActivationDatabase();
    Object.assign(state.subscription, { status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingShopifyPlanHandle: "growth", pendingPlanId: "paid-1", pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"), nextReconcileAt: new Date("2026-09-12T00:00:00.000Z") });
    const now = new Date("2026-09-14T00:00:00.000Z");
    vi.setSystemTime(now);
    try {
      const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) };
      const service = new BillingService(provider, database as never);
      await service.syncSubscription("shop-1", {
        subscriptionId: "subscription-1", pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth",
        pendingEffectiveAt: state.subscription.pendingEffectiveAt, nextReconcileAt: state.subscription.nextReconcileAt, planKind: "PAID_METERED",
      });
      expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
      expect(state.subscription.nextReconcileAt).toEqual(new Date(periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS));
    } finally {
      vi.useRealTimers();
    }
  });
  function createFreeActivationDatabase({
    currentSubscription = null,
    onboardingCompleted = false,
    lifetimeCounter = null,
    planOverrides = {},
  }: {
    currentSubscription?: Record<string, unknown> | null;
    onboardingCompleted?: boolean;
    lifetimeCounter?: Record<string, unknown> | null;
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
    const state: {
      currentSubscription: Record<string, unknown> | null;
      onboardingCompleted: boolean;
      lifetimeCounter: Record<string, unknown> | null;
    } = {
      currentSubscription: currentSubscription
        ? { id: "subscription-1", ...currentSubscription }
        : null,
      onboardingCompleted,
      lifetimeCounter,
    };
    const subscription = {
      findUnique: vi.fn().mockImplementation(async () => state.currentSubscription
        ? { ...state.currentSubscription, plan: state.currentSubscription["plan"] ?? freePlan }
        : null),
      upsert: vi.fn().mockImplementation(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
        state.currentSubscription = { ...(state.currentSubscription ?? create), id: "subscription-1", ...update };
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
    const billingPeriodEntitlementCounter = {
      create: vi.fn(),
      upsert: vi.fn(),
    };
    const billingPeriod = {
      upsert: vi.fn().mockResolvedValue({ id: "period-1" }),
    };
    const database = {
      billingPlan: {
        findUnique: vi.fn().mockResolvedValue(freePlan),
      },
      recoveryCreditPurchase: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      shop: {
        findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }),
      },
      subscription,
      shopSettings,
      billingPeriod,
      shopEntitlementCounter,
      billingPeriodEntitlementCounter,
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        subscription,
        shopSettings,
        billingPlan: database.billingPlan,
        billingPeriod,
        shopEntitlementCounter,
        $queryRaw: database.$queryRaw,
      })),
    };
    return { database, state, freePlan, shopSettings, shopEntitlementCounter, billingPeriod, billingPeriodEntitlementCounter };
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

    await expect(service.prepareFreeActivation("shop-1", "free")).resolves.toMatchObject({
      mode: "VERIFIED_REPLAY",
      token: null,
    });
  });

  it("preserves an existing lifetime counter on verified replay", async () => {
    const existingCounter = {
      grantedQuantity: 5,
      committedQuantity: 3,
      reservedQuantity: 1,
      forfeitedQuantity: 0,
    };
    const { database, shopEntitlementCounter } = createFreeActivationDatabase({
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
      id: "subscription-1",
      status: "ACTIVE",
      planId: "free-1",
      observedShopifyPlanHandle: "free",
      pendingShopifyPlanHandle: "free",
      pendingPlanId: "free-1",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: null,
      plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.completeFreeActivation("shop-1", "free")).resolves.toMatchObject({
      subscriptionId: "subscription-1",
    });

    expect(shopEntitlementCounter.create).not.toHaveBeenCalled();
    expect(existingCounter).toEqual({
      grantedQuantity: 5,
      committedQuantity: 3,
      reservedQuantity: 1,
      forfeitedQuantity: 0,
    });
  });

  it("does not complete an older callback over a newer pending Free selection", async () => {
    const { database, state, shopSettings } = createFreeActivationDatabase({
      currentSubscription: {
        status: "ACTIVE",
        planId: "free-a-id",
        observedShopifyPlanHandle: "free-a",
        pendingShopifyPlanHandle: "free-b",
        pendingPlanId: "free-b-id",
        pendingEffectiveAt: new Date("2026-09-12T00:02:00.000Z"),
        nextReconcileAt: new Date("2026-09-12T00:03:00.000Z"),
      },
    });
    database.subscription.findUnique.mockResolvedValue({
      ...state.currentSubscription,
      plan: { kind: "FREE", shopifyPlanHandle: "free-a", recoveryCreditPackEnabled: false },
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.completeFreeActivation("shop-1", "free-a")).resolves.toBeNull();

    expect(shopSettings.update).not.toHaveBeenCalled();
    expect(state.onboardingCompleted).toBe(false);
    expect(state.currentSubscription).toMatchObject({
      pendingShopifyPlanHandle: "free-b",
      pendingPlanId: "free-b-id",
    });
  });

  it("does not create a periodic Free entitlement counter during activation", async () => {
    const { database, billingPeriodEntitlementCounter } = createFreeActivationDatabase({
      onboardingCompleted: true,
      currentSubscription: {
        status: "ACTIVE",
        planId: "free-1",
        observedShopifyPlanHandle: "free",
        plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
      },
      lifetimeCounter: { grantedQuantity: 5, committedQuantity: 3, reservedQuantity: 1 },
    });
    database.subscription.findUnique.mockResolvedValue({
      id: "subscription-1",
      status: "ACTIVE",
      planId: "free-1",
      observedShopifyPlanHandle: "free",
      plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: false },
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.completeFreeActivation("shop-1", "free")).resolves.toMatchObject({
      subscriptionId: "subscription-1",
    });

    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
  });

  it("preserves every lifetime quantity and version across an exact Free cycle replay", async () => {
    const existingCounter = {
      grantedQuantity: 5,
      committedQuantity: 3,
      reservedQuantity: 1,
      refundingQuantity: 1,
      version: 7,
    };
    const { database, state, billingPeriodEntitlementCounter } = createFreeActivationDatabase({
      onboardingCompleted: true,
      currentSubscription: {
        status: "ACTIVE",
        planId: "free-1",
        observedShopifyPlanHandle: "free",
        billingPeriodId: "period-1",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: true },
      },
      lifetimeCounter: existingCounter,
      planOverrides: { recoveryCreditPackEnabled: true },
    });
    database.subscription.findUnique.mockResolvedValue({
      ...state.currentSubscription,
      plan: { kind: "FREE", shopifyPlanHandle: "free", recoveryCreditPackEnabled: true },
    });
    const service = new BillingService({} as never, database as never);

    await expect(service.completeFreeActivation("shop-1", "free")).resolves.toMatchObject({
      subscriptionId: "subscription-1",
    });

    expect(existingCounter).toEqual({
      grantedQuantity: 5,
      committedQuantity: 3,
      reservedQuantity: 1,
      refundingQuantity: 1,
      version: 7,
    });
    expect(billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
    expect(billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
  });

  it("proves the ShopSettings lock precedes the Subscription lock", async () => {
    const { database } = createFreeActivationDatabase();
    const lockSql: string[] = [];
    database.$queryRaw.mockImplementation(async (query: { sql?: string }) => {
      lockSql.push(query.sql ?? "");
      return [];
    });
    const service = new BillingService({} as never, database as never);

    await service.prepareFreeActivation("shop-1", "free");

    expect(lockSql[0]).toContain('FROM "shopify"."ShopSettings"');
    expect(lockSql[0]).toContain("FOR UPDATE");
    expect(lockSql[1]).toContain('FROM "billing"."Subscription"');
    expect(lockSql[1]).toContain("FOR UPDATE");
  });

  it("ignores a stale token before projecting an active Partner response", async () => {
    const { database, state, billingPeriod } = createFreeActivationDatabase();
    const provider = {
      getActiveSubscription: vi.fn().mockImplementation(async () => {
        state.currentSubscription = {
          ...state.currentSubscription,
          pendingPlanId: "free-b-id",
          pendingShopifyPlanHandle: "free-b",
          pendingEffectiveAt: new Date("2026-09-12T10:01:00.000Z"),
          nextReconcileAt: new Date("2026-09-12T10:01:00.000Z"),
        };
        return providerSubscription({ planHandle: "free" });
      }),
    };
    const service = new BillingService(provider, database as never);
    const activation = await service.prepareFreeActivation("shop-1", "free");
    if (!activation?.token) throw new Error("Expected an initial activation token.");
    database.subscription.upsert.mockClear();
    database.subscription.update.mockClear();

    await service.syncSubscription("shop-1", activation.token);

    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
    expect(database.subscription.upsert).not.toHaveBeenCalled();
    expect(database.subscription.update).not.toHaveBeenCalled();
    expect(billingPeriod.upsert).not.toHaveBeenCalled();
    expect(state.currentSubscription).toMatchObject({
      pendingPlanId: "free-b-id",
      pendingShopifyPlanHandle: "free-b",
    });
  });

  it("ignores a stale token before projecting a provider-null response", async () => {
    const { database, state } = createFreeActivationDatabase();
    const provider = {
      getActiveSubscription: vi.fn().mockImplementation(async () => {
        state.onboardingCompleted = true;
        state.currentSubscription = {
          ...state.currentSubscription,
          status: "ACTIVE",
          planId: "free-b-id",
          observedShopifyPlanHandle: "free-b",
          pendingPlanId: null,
          pendingShopifyPlanHandle: null,
          pendingEffectiveAt: null,
          nextReconcileAt: null,
        };
        return null;
      }),
    };
    const service = new BillingService(provider, database as never);
    const activation = await service.prepareFreeActivation("shop-1", "free");
    if (!activation?.token) throw new Error("Expected an initial activation token.");
    database.subscription.upsert.mockClear();
    database.subscription.update.mockClear();

    await service.syncSubscription("shop-1", activation.token);

    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
    expect(database.subscription.upsert).not.toHaveBeenCalled();
    expect(database.subscription.update).not.toHaveBeenCalled();
    expect(state.onboardingCompleted).toBe(true);
    expect(state.currentSubscription).toMatchObject({
      planId: "free-b-id",
      pendingPlanId: null,
    });
  });

  it("treats a changed initial token schedule as stale", async () => {
    const { database, state, billingPeriod } = createFreeActivationDatabase();
    const provider = {
      getActiveSubscription: vi.fn().mockImplementation(async () => {
        state.currentSubscription = {
          ...state.currentSubscription,
          pendingEffectiveAt: new Date("2026-09-12T10:01:00.000Z"),
        };
        return providerSubscription({ planHandle: "free" });
      }),
    };
    const service = new BillingService(provider, database as never);
    const activation = await service.prepareFreeActivation("shop-1", "free");
    if (!activation?.token) throw new Error("Expected an initial activation token.");
    database.subscription.upsert.mockClear();
    database.subscription.update.mockClear();

    await service.syncSubscription("shop-1", activation.token);

    expect(database.subscription.upsert).not.toHaveBeenCalled();
    expect(database.subscription.update).not.toHaveBeenCalled();
    expect(billingPeriod.upsert).not.toHaveBeenCalled();
  });

  it("makes a stale guarded retry scheduler a full no-op", async () => {
    const { database, state } = createFreeActivationDatabase();
    const service = new BillingService({} as never, database as never);
    const activation = await service.prepareFreeActivation("shop-1", "free");
    if (!activation?.token) throw new Error("Expected an initial activation token.");
    state.currentSubscription = {
      ...state.currentSubscription,
      pendingPlanId: "free-b-id",
      pendingShopifyPlanHandle: "free-b",
    };
    database.subscription.update.mockClear();

    await expect(service.scheduleInitialFreeReconciliationIfCurrent({
      shopId: "shop-1",
      expected: activation.token,
      nextReconcileAt: new Date("2026-09-12T10:02:00.000Z"),
      partnerErrorAt: new Date("2026-09-12T10:01:30.000Z"),
    })).resolves.toBeNull();

    expect(database.subscription.update).not.toHaveBeenCalled();
    expect(state.currentSubscription).toMatchObject({
      pendingPlanId: "free-b-id",
      pendingShopifyPlanHandle: "free-b",
    });
  });

  it("commits one guarded Partner-error retry for the current token", async () => {
    const { database } = createFreeActivationDatabase();
    const service = new BillingService({} as never, database as never);
    const activation = await service.prepareFreeActivation("shop-1", "free");
    if (!activation?.token) throw new Error("Expected an initial activation token.");
    database.subscription.update.mockClear();
    const nextReconcileAt = new Date("2026-09-12T10:01:00.000Z");
    const partnerErrorAt = new Date("2026-09-12T10:00:30.000Z");

    await expect(service.scheduleInitialFreeReconciliationIfCurrent({
      shopId: "shop-1",
      expected: activation.token,
      nextReconcileAt,
      partnerErrorAt,
    })).resolves.toEqual({
      subscriptionId: "subscription-1",
      nextReconcileAt,
    });

    expect(database.subscription.update).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      select: { id: true, nextReconcileAt: true },
      data: {
        nextReconcileAt,
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: partnerErrorAt,
      },
    });
  });

  it("completes an initial pack-enabled Free activation without a cycle and keeps top-up eligibility closed", async () => {
    const { database, state } = createFreeActivationDatabase({
      planOverrides: {
        recoveryCreditPackEnabled: true,
        shopifyRecoveryCreditPackEventHandle: "credit-pack-meter",
        recoveryCreditsPerPack: 100,
      },
    });
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
        planHandle: "free",
        currentPeriodStart: null,
        currentPeriodEnd: null,
      })),
    };
    const service = new BillingService(provider, database as never);

    const activation = await service.prepareFreeActivation("shop-1", "free");
    expect(activation?.mode).toBe("INITIAL");
    if (!activation?.token) throw new Error("Expected an initial activation token.");
    await service.syncSubscription("shop-1", activation.token);
    const beforeCompletion = Date.now();
    const completed = await service.completeFreeActivation("shop-1", "free");

    expect(completed?.nextReconcileAt).toBeInstanceOf(Date);
    expect(state.onboardingCompleted).toBe(true);
    expect(state.currentSubscription).toMatchObject({
      status: "ACTIVE",
      planId: "free-1",
      billingPeriodId: null,
      pendingShopifyPlanHandle: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
    });
    const nextReconcileAt = state.currentSubscription?.["nextReconcileAt"];
    expect(nextReconcileAt).toBeInstanceOf(Date);
    if (!(nextReconcileAt instanceof Date)) throw new Error("Expected a retry schedule.");
    expect(nextReconcileAt.getTime()).toBeGreaterThanOrEqual(beforeCompletion + 60_000);

    await expect(service.requestRecoveryCreditPack(
      "shop-1",
      "BUY_RECOVERY_CREDIT_PACK",
      "11111111-1111-4111-8111-111111111111",
    )).rejects.toThrow("The current local billing cycle could not be verified.");
    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
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

  it("classifies Shopify lifecycle states without mutating the local Subscription projection", async () => {
    const { database } = createDatabase({
      plan: { id: "growth-1", name: "Growth", kind: "PAID_METERED" },
    });
    const latestEvent = {
      id: "event-1",
      eventType: "SUBSCRIPTION_FROZEN" as const,
      state: "FROZEN" as const,
      occurredAt: new Date("2026-09-12T12:00:00.000Z"),
      cancelEffectiveOn: null,
      planHandle: "growth",
      billingPeriod: "EVERY_30_DAYS",
    };
    const provider = {
      getActiveSubscription: vi.fn(),
      getSubscriptionLifecycleSnapshot: vi.fn().mockResolvedValue({
        activeSubscription: null,
        latestLifecycleEvent: latestEvent,
      }),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifyLifecycleState("shop-1")).resolves.toMatchObject({
      state: "FROZEN",
      subscription: null,
      providerPlanHandle: "growth",
      billingPeriod: "EVERY_30_DAYS",
      mappingStatus: "MAPPED",
      modaMapping: { id: "growth-1", name: "Growth" },
    });
    expect(provider.getSubscriptionLifecycleSnapshot).toHaveBeenCalledTimes(1);
    expect(provider.getActiveSubscription).not.toHaveBeenCalled();
    expect(database.subscription.upsert).not.toHaveBeenCalled();
    expect(database.subscription.update).not.toHaveBeenCalled();
    expect(database.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("preserves the complete active commercial projection when lifecycle evidence is non-freezing", async () => {
    const { database } = createDatabase({
      plan: { id: "growth-1", name: "Growth", kind: "PAID_METERED" },
    });
    const provider = {
      getActiveSubscription: vi.fn(),
      getSubscriptionLifecycleSnapshot: vi.fn().mockResolvedValue({
        activeSubscription: providerSubscription({
          currentFlatRatePlan: { handle: "growth", description: "Growth", price: { amount: "19", currency: "GBP" } },
          billingPeriod: "ANNUAL",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          trialEndsAt: new Date("2026-09-15T00:00:00.000Z"),
          cancelAtPeriodEnd: true,
          pendingFlatRatePlan: {
            handle: "starter",
            price: { amount: "0", currency: "GBP" },
            effectiveAt: periodEnd,
          },
          usageItems: [{ handle: "meter", description: "Meter", price: { kind: "TIERED", active: true, currency: "GBP", tiersMode: "VOLUME", tiers: [] }, usage: null }],
        }),
        latestLifecycleEvent: {
          id: "event-1", state: "UPDATED", eventType: "SUBSCRIPTION_UPDATED", occurredAt: periodStart,
          cancelEffectiveOn: null, planHandle: "growth", billingPeriod: "ANNUAL",
        },
      }),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifyLifecycleState("shop-1")).resolves.toMatchObject({
      state: "ACTIVE",
      subscription: {
        status: "ACTIVE_SUBSCRIPTION",
        subscription: {
          planHandle: "growth",
          description: "Growth",
          price: { amount: "19", currency: "GBP" },
          billingPeriod: "ANNUAL",
          currentPeriodStart: periodStart.toISOString(),
          currentPeriodEnd: periodEnd.toISOString(),
          trialEndsAt: "2026-09-15T00:00:00.000Z",
          cancelAtEndOfCycle: true,
          pendingUpdate: { planHandle: "starter", effectiveAt: periodEnd.toISOString() },
          usageItems: [{ handle: "meter" }],
        },
        mappingStatus: "MAPPED",
        modaMapping: { id: "growth-1", name: "Growth", kind: "PAID_METERED" },
      },
    });
  });

  it("gives the latest frozen lifecycle event precedence over a live subscription", async () => {
    const { database } = createDatabase({ plan: { id: "growth-1", name: "Growth", kind: "PAID_METERED" } });
    const provider = {
      getActiveSubscription: vi.fn(),
      getSubscriptionLifecycleSnapshot: vi.fn().mockResolvedValue({
        activeSubscription: providerSubscription({ planHandle: "growth" }),
        latestLifecycleEvent: {
          id: "event-1", state: "FROZEN", eventType: "SUBSCRIPTION_FROZEN", occurredAt: periodStart,
          cancelEffectiveOn: null, planHandle: "growth", billingPeriod: "EVERY_30_DAYS",
        },
      }),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifyLifecycleState("shop-1")).resolves.toMatchObject({
      state: "FROZEN",
      subscription: { status: "ACTIVE_SUBSCRIPTION", subscription: { planHandle: "growth" } },
      providerPlanHandle: "growth",
      billingPeriod: "EVERY_30_DAYS",
    });
  });

  it.each([
    ["ACTIVE", providerSubscription(), { state: "UPDATED", eventType: "SUBSCRIPTION_UPDATED", cancelEffectiveOn: null }],
    ["CANCELED", null, { state: "CANCELED", eventType: "SUBSCRIPTION_CANCELED", cancelEffectiveOn: null }],
    ["UNRESOLVED", null, { state: "UNFROZEN", eventType: "SUBSCRIPTION_UNFROZEN", cancelEffectiveOn: null }],
    ["UNRESOLVED", null, { state: "CREATED", eventType: "SUBSCRIPTION_CREATED", cancelEffectiveOn: null }],
    ["UNRESOLVED", null, { state: "UPDATED", eventType: "SUBSCRIPTION_UPDATED", cancelEffectiveOn: null }],
    ["UNRESOLVED", null, { state: "CANCELLATION_SCHEDULED", eventType: "SUBSCRIPTION_CANCELLATION_SCHEDULED", cancelEffectiveOn: "2026-10-01" }],
    ["FROZEN", null, { state: "FROZEN", eventType: "SUBSCRIPTION_FROZEN", cancelEffectiveOn: null }],
  ] as const)("returns the Shopify lifecycle state %s", async (state, activeSubscription, event) => {
    const { database } = createDatabase({ plan: { id: "growth-1", name: "Growth", kind: "PAID_METERED" } });
    const provider = {
      getActiveSubscription: vi.fn(),
      getSubscriptionLifecycleSnapshot: vi.fn().mockResolvedValue({
        activeSubscription,
        latestLifecycleEvent: {
          id: "event-1",
          eventType: event.eventType,
          state: event.state,
          occurredAt: periodStart,
          cancelEffectiveOn: event.cancelEffectiveOn,
          planHandle: "growth",
          billingPeriod: "EVERY_30_DAYS",
        },
      }),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifyLifecycleState("shop-1"))
      .resolves.toMatchObject({ state, ...(event.state === "CANCELLATION_SCHEDULED" ? { latestEvent: { cancelEffectiveOn: "2026-10-01" } } : {}) });
  });

  it.each([
    ["mapped", { id: "growth-1", name: "Growth", kind: "PAID_METERED" }, "MAPPED"],
    ["unmapped", null, "UNMAPPED"],
  ] as const)("keeps %s frozen mapping separate from provider presentation", async (_name, plan, mappingStatus) => {
    const { database } = createDatabase({ plan: plan as BillingPlanFixture | null });
    const provider = {
      getSubscriptionLifecycleSnapshot: vi.fn().mockResolvedValue({
        activeSubscription: null,
        latestLifecycleEvent: {
          id: "event-1", state: "FROZEN", eventType: "SUBSCRIPTION_FROZEN", occurredAt: periodStart,
          cancelEffectiveOn: null, planHandle: "growth", billingPeriod: "EVERY_30_DAYS",
        },
      }),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifyLifecycleState("shop-1")).resolves.toMatchObject({
      state: "FROZEN",
      providerPlanHandle: "growth",
      billingPeriod: "EVERY_30_DAYS",
      mappingStatus,
      modaMapping: plan ? { id: "growth-1", name: "Growth", kind: "PAID_METERED" } : null,
    });
  });

  it("propagates lifecycle provider failure without local fallback or writes", async () => {
    const { database } = createDatabase({
      current: { status: "ACTIVE", planId: "growth-1", observedShopifyPlanHandle: "growth" },
      plan: { id: "growth-1", name: "Growth", kind: "PAID_METERED" },
    });
    const provider = {
      getActiveSubscription: vi.fn(),
      getSubscriptionLifecycleSnapshot: vi.fn().mockRejectedValue(new Error("Partner verification failed")),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifyLifecycleState("shop-1"))
      .rejects.toThrow("Partner verification failed");
    expect(database.subscription.upsert).not.toHaveBeenCalled();
    expect(database.subscription.update).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("returns no active subscription for a fresh merchant without provider history", async () => {
    const { database } = createDatabase();
    const provider = {
      getActiveSubscription: vi.fn(),
      getSubscriptionLifecycleSnapshot: vi.fn().mockResolvedValue({
        activeSubscription: null,
        latestLifecycleEvent: null,
      }),
    };
    const service = new BillingService(provider, database as never);

    await expect(service.getMerchantShopifyLifecycleState("shop-1")).resolves.toEqual({
      state: "NO_ACTIVE_SUBSCRIPTION",
      subscription: null,
      latestEvent: null,
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
          shopSettings: { findUnique: vi.fn().mockResolvedValue({ onboardingCompleted: true }) },
          $queryRaw: vi.fn().mockResolvedValue([]),
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
        pendingPlanHandle: "free-a",
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
    billingPeriod: { id: "period-1", periodStart, periodEnd, status: "OPEN" },
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

describe("BillingService merchant billing state", () => {
  function createValidPaidMerchantState() {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const plan = {
      id: "growth-1",
      kind: "PAID_METERED",
      shopifyPlanHandle: "growth",
      active: true,
      recoveryCreditPackEnabled: false,
    };
    const period = {
      id: "period-1",
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      planId: "growth-1",
      shopifyPlanHandleSnapshot: "growth",
      planKindSnapshot: "PAID_METERED",
      periodStart,
      periodEnd,
      status: "OPEN",
      includedRecoveryCreditsGranted: 100,
      entitlementCounters: [{
        shopId: "shop-1",
        billingPeriodId: "period-1",
        counter: "INCLUDED_RECOVERY_CREDITS",
        grantedQuantity: 100,
        committedQuantity: 12,
        reservedQuantity: 8,
        forfeitedQuantity: 5,
      }],
    };
    const state = {
      subscription: {
        id: "subscription-1",
        status: "ACTIVE",
        billingPeriodId: "period-1",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        observedShopifyPlanHandle: "growth",
        plan,
        billingPeriod: period,
      },
    };
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: null }) },
      subscription: { findUnique: vi.fn().mockImplementation(async () => state.subscription) },
      shopEntitlementCounter: { findUnique: vi.fn().mockResolvedValue(null) },
      usageEvent: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 999 } }) },
    };
    return { database, state, period, plan };
  }

  it("uses the canonical lifetime counter for a mapped Free plan",
    async () => {
      const lifetimeCounter = {
        grantedQuantity: 10,
        committedQuantity: 4,
        reservedQuantity: 3,
      };
      const database = {
        shop: {
          findUnique: vi.fn().mockResolvedValue({
            id: "shop-1",
            shopifyShopId: null,
          }),
        },
        subscription: {
          findUnique: vi.fn().mockResolvedValue({
            status: "ACTIVE",
            plan: {
              kind: "FREE",
              active: true,
              recoveryCreditPackEnabled: false,
            },
          }),
        },
        shopEntitlementCounter: {
          findUnique: vi.fn().mockImplementation(async ({ where }: { where: { shopId_counter: { counter: string } } }) =>
            where.shopId_counter.counter === "PURCHASED_RECOVERY_CREDITS"
              ? null
              : lifetimeCounter),
        },
        usageEvent: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 4 } }),
        },
      };
      const service = new BillingService({} as never, database as never);

      await expect(service.getMerchantBillingState("shop-1")).resolves.toMatchObject({
        allowance: 10,
        committed: 4,
        reserved: 3,
        remaining: 3,
        lifetimeFree: { grantedQuantity: 10, remaining: 3 },
      });
    },
  );

  it("uses the current paid period counter and preserves lifetime Free capacity", async () => {
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: null }) },
      subscription: {
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1",
          status: "ACTIVE",
          observedShopifyPlanHandle: "growth",
          billingPeriodId: "period-1",
          currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
          plan: {
            id: "growth-1",
            kind: "PAID_METERED",
            shopifyPlanHandle: "growth",
            active: true,
            recoveryCreditPackEnabled: false,
          },
          billingPeriod: {
            id: "period-1",
            shopId: "shop-1",
            subscriptionId: "subscription-1",
            planId: "growth-1",
            shopifyPlanHandleSnapshot: "growth",
            planKindSnapshot: "PAID_METERED",
            periodStart: new Date("2026-09-01T00:00:00.000Z"),
            periodEnd: new Date("2026-10-01T00:00:00.000Z"),
            status: "OPEN",
            includedRecoveryCreditsGranted: 100,
            entitlementCounters: [{
              shopId: "shop-1",
              billingPeriodId: "period-1",
              counter: "INCLUDED_RECOVERY_CREDITS",
              grantedQuantity: 100,
              committedQuantity: 12,
              reservedQuantity: 8,
              forfeitedQuantity: 5,
            }],
          },
        }),
      },
      shopEntitlementCounter: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { shopId_counter: { counter: string } } }) =>
          where.shopId_counter.counter === "PURCHASED_RECOVERY_CREDITS"
            ? {
                grantedQuantity: 100,
                committedQuantity: 20,
                reservedQuantity: 5,
                refundingQuantity: 10,
              }
            : { grantedQuantity: 50, committedQuantity: 10, reservedQuantity: 5 }),
      },
      usageEvent: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 999 } }) },
    };
    const service = new BillingService({} as never, database as never);

    await expect(service.getMerchantBillingState("shop-1")).resolves.toMatchObject({
      allowance: null,
      remaining: null,
      paidIncluded: {
        grantedQuantity: 100,
        committedQuantity: 12,
        reservedQuantity: 8,
        forfeitedQuantity: 5,
        remaining: 75,
      },
      purchasedRecoveryCredits: {
        grantedQuantity: 100,
        committedQuantity: 20,
        reservedQuantity: 5,
        refundingQuantity: 10,
        available: 65,
      },
      lifetimeFree: { grantedQuantity: 50, remaining: 35 },
    });
  });

  it("subtracts purchased refund holds from merchant available credits", async () => {
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: null }) },
      subscription: { findUnique: vi.fn().mockResolvedValue(null) },
      shopEntitlementCounter: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { shopId_counter: { counter: string } } }) =>
          where.shopId_counter.counter === "PURCHASED_RECOVERY_CREDITS"
            ? { grantedQuantity: 100, committedQuantity: 20, reservedQuantity: 5, refundingQuantity: 10 }
            : null),
      },
      usageEvent: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 9999 } }) },
    };
    const service = new BillingService({} as never, database as never);

    await expect(service.getMerchantBillingState("shop-1")).resolves.toMatchObject({
      purchasedRecoveryCredits: {
        grantedQuantity: 100,
        committedQuantity: 20,
        reservedQuantity: 5,
        refundingQuantity: 10,
        available: 65,
      },
      usageQuantity: 9999,
    });
  });

  it.each([
    ["billingPeriod relation missing", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.state.subscription.billingPeriod = null as never; }],
    ["billingPeriodId missing", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.state.subscription.billingPeriodId = null as never; }],
    ["period status CLOSED", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.status = "CLOSED"; }],
    ["period shopId differs", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.shopId = "shop-2"; }],
    ["period subscriptionId differs", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.subscriptionId = "subscription-2"; }],
    ["period planId differs", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.planId = "growth-2"; }],
    ["period Shopify handle snapshot differs", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.shopifyPlanHandleSnapshot = "starter"; }],
    ["period plan kind snapshot is FREE", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.planKindSnapshot = "FREE"; }],
    ["period boundary differs from Subscription", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.periodEnd = new Date("2026-10-02T00:00:00.000Z"); }],
    ["periodStart >= periodEnd", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.periodEnd = fixture.period.periodStart; }],
    ["includedRecoveryCreditsGranted is null", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.includedRecoveryCreditsGranted = null as never; }],
    ["includedRecoveryCreditsGranted is negative", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.includedRecoveryCreditsGranted = -1; }],
    ["included counter missing", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.entitlementCounters = []; }],
    ["counter shopId differs", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.entitlementCounters[0].shopId = "shop-2"; }],
    ["counter billingPeriodId differs", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.entitlementCounters[0].billingPeriodId = "period-2"; }],
    ["counter granted differs from period grant", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.entitlementCounters[0].grantedQuantity = 99; }],
    ["counter committed is negative", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.entitlementCounters[0].committedQuantity = -1; }],
    ["counter reserved is negative", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.entitlementCounters[0].reservedQuantity = -1; }],
    ["counter forfeited is negative", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.entitlementCounters[0].forfeitedQuantity = -1; }],
    ["committed + reserved + forfeited exceeds granted", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.period.entitlementCounters[0].committedQuantity = 90; fixture.period.entitlementCounters[0].reservedQuantity = 20; }],
    ["current BillingPlan inactive", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.plan.active = false; }],
    ["observed Shopify handle differs from mapped plan handle", (fixture: ReturnType<typeof createValidPaidMerchantState>) => { fixture.state.subscription.observedShopifyPlanHandle = "starter"; }],
  ] as const)("fails merchant Paid presentation closed for inconsistent current period: %s", async (_name, invalidate) => {
    const fixture = createValidPaidMerchantState();
    invalidate(fixture);
    const service = new BillingService({} as never, fixture.database as never);

    const result = await service.getMerchantBillingState("shop-1");

    expect(result.paidIncluded).toBeNull();
    expect(result.paidConfigurationUnavailable).toBe(true);
    if (_name === "billingPeriod relation missing" || _name === "included counter missing") {
      expect(result.usageQuantity).toBe(999);
      expect(result.paidIncluded).not.toEqual({ remaining: result.usageQuantity });
    }
  });
});

describe("BillingService recovery credit packs", () => {
    it.each([
      ["ACTIVE", new Date(periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS - 1)],
      ["DRAINING", new Date(periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)],
      ["RECONCILING", periodEnd],
    ] as const)("derives %s from exact period timestamps", (expected, now) => {
      expect(deriveBillingPeriodPhase(periodEnd, now)).toBe(expected);
    });

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

  it.each(["PAID_METERED", "FREE"] as const)(
    "blocks a new %s pack request during billing-cycle transition",
    async (kind) => {
      const { database, purchases, usageEvents, subscriptionState, transactionSubscription } =
        createRecoveryCreditPurchaseDatabase({
          kind,
          ...(kind === "FREE" ? { shopifyUsageEventHandle: null } : {}),
        });
      const transitionEnd = new Date(Date.now() + APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS / 2);
      Object.assign(subscriptionState, {
        currentPeriodEnd: transitionEnd,
        billingPeriod: { id: "period-1", periodStart, periodEnd: transitionEnd, status: "OPEN" },
      });
      Object.assign(transactionSubscription, subscriptionState);
      const provider = {
        getActiveSubscription: vi.fn().mockResolvedValue(
          providerSubscription({
            usageEventHandles: ["message-meter", "credit-pack-meter"],
            currentPeriodEnd: transitionEnd,
          }),
        ),
      };
      const service = new BillingService(provider, database as never);

      await expect(
        service.requestRecoveryCreditPack(
          "shop-1",
          "BUY_RECOVERY_CREDIT_PACK",
          kind === "FREE"
            ? "f1111111-1111-4111-8111-111111111111"
            : "a1111111-1111-4111-8111-111111111111",
        ),
      ).rejects.toThrow("temporarily unavailable");
      expect(usageEvents).toHaveLength(0);
      expect(purchases).toHaveLength(0);
    },
  );

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
