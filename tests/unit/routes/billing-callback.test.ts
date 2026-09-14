import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  redirect: vi.fn((location: string) => ({ location })),
  resolveShop: vi.fn(),
  getFence: vi.fn(),
  getState: vi.fn(),
  recordReturn: vi.fn(),
  recordFailure: vi.fn(),
  prepareFreeActivation: vi.fn(),
  preparePaidActivation: vi.fn(),
  syncSubscription: vi.fn(),
  getSubscriptionProjection: vi.fn(),
  completeFreeActivation: vi.fn(),
  scheduleInitialFreeReconciliationIfCurrent: vi.fn(),
  enqueueReconcile: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: {
    getHostedPlanVerificationFence: mocks.getFence,
    getMerchantShopifySubscriptionState: mocks.getState,
    recordHostedPlanChangeReturn: mocks.recordReturn,
    recordHostedPlanVerificationFailure: mocks.recordFailure,
    prepareFreeActivation: mocks.prepareFreeActivation,
    preparePaidActivation: mocks.preparePaidActivation,
    syncSubscription: mocks.syncSubscription,
    getSubscriptionProjection: mocks.getSubscriptionProjection,
    completeFreeActivation: mocks.completeFreeActivation,
    scheduleInitialFreeReconciliationIfCurrent: mocks.scheduleInitialFreeReconciliationIfCurrent,
  },
  INITIAL_BILLING_RETRY_DELAY_MS: 60_000,
}));
vi.mock("../../../app/services/billing/billing-reconciliation.service", () => ({
  enqueueBillingSubscriptionReconcileBestEffort: mocks.enqueueReconcile,
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: mocks.resolveShop },
}));

import { loader } from "../../../app/routes/app/billing/callback/route";

const shop = { id: "shop-1", status: "ACTIVE" };
const freePlan = { id: "free-1", kind: "FREE", shopifyPlanHandle: "free" };
const paidPlan = { id: "paid-1", kind: "PAID_METERED", shopifyPlanHandle: "growth" };
const initialToken = Object.freeze({
  subscriptionId: "subscription-1",
  pendingPlanId: "free-1",
  pendingShopifyPlanHandle: "free",
  pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
  nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
});
const verificationFence = Object.freeze({
  id: "subscription-1",
  updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  status: "ACTIVE",
  observedShopifyPlanHandle: "free",
  planId: "free-1",
  billingPeriodId: "period-1",
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  pendingShopifyPlanHandle: null,
  pendingPlanId: null,
  pendingEffectiveAt: null,
  nextReconcileAt: null,
  lastSyncedAt: null,
  lastSyncErrorCode: null,
  lastSyncErrorAt: null,
});

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "subscription-1",
    status: "ACTIVE",
    observedShopifyPlanHandle: "free",
    planId: "free-1",
    plan: freePlan,
    pendingShopifyPlanHandle: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    nextReconcileAt: null,
    ...overrides,
  };
}

function request(planHandle?: string) {
  const suffix = planHandle === undefined ? "" : `?plan_handle=${planHandle}`;
  return new Request(`https://app.test/app/billing/callback${suffix}`);
}

async function runLoader(planHandle?: string) {
  return loader({ request: request(planHandle) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({
    admin: {},
    redirect: mocks.redirect,
    session: { shop: "example.myshopify.com" },
  });
  mocks.resolveShop.mockResolvedValue(shop);
  mocks.getFence.mockResolvedValue(verificationFence);
  mocks.getState.mockResolvedValue({
    status: "ACTIVE_SUBSCRIPTION",
    subscription: {
      planHandle: "growth",
      price: { amount: "75.00", currency: "GBP" },
      billingPeriod: "EVERY_30_DAYS",
      currentPeriodStart: "2026-09-01T00:00:00.000Z",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      trialEndsAt: null,
      cancelAtEndOfCycle: false,
      pendingUpdate: { planHandle: "free", price: { amount: "0.00", currency: "GBP" }, effectiveAt: "2026-10-01T00:00:00.000Z" },
      usageItems: [],
    },
    modaMapping: { id: "growth-id", name: "Growth", kind: "PAID_METERED" },
    mappingStatus: "MAPPED",
    pendingModaMapping: { id: "free-id", name: "Free", kind: "FREE" },
  });
  mocks.prepareFreeActivation.mockResolvedValue({ plan: freePlan, mode: "INITIAL", token: initialToken });
  mocks.preparePaidActivation.mockResolvedValue(null);
  mocks.syncSubscription.mockResolvedValue(subscription());
  mocks.getSubscriptionProjection.mockResolvedValue(subscription());
  mocks.completeFreeActivation.mockResolvedValue({
    subscriptionId: "subscription-1",
    nextReconcileAt: null,
  });
  mocks.scheduleInitialFreeReconciliationIfCurrent.mockResolvedValue({
    subscriptionId: "subscription-1",
    nextReconcileAt: new Date("2026-09-12T00:01:00.000Z"),
  });
  mocks.recordReturn.mockResolvedValue({ result: "pending", subscriptionId: "subscription-1", nextReconcileAt: new Date("2026-10-01T00:00:00.000Z") });
  mocks.recordFailure.mockResolvedValue({ subscriptionId: "subscription-1", nextReconcileAt: new Date("2026-09-12T00:01:00.000Z") });
});

describe("billing callback activation", () => {
  it("completes onboarding only after current Free verification", async () => {
    await runLoader("free");

    expect(mocks.prepareFreeActivation).toHaveBeenCalledWith("shop-1", "free");
    expect(mocks.syncSubscription).toHaveBeenCalledWith("shop-1", initialToken);
    expect(mocks.completeFreeActivation).toHaveBeenCalledWith("shop-1", "free");
    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("records and completes a first paid activation only after matching verification", async () => {
    const paidToken = { ...initialToken, pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth" };
    mocks.prepareFreeActivation.mockResolvedValue(null);
    mocks.preparePaidActivation.mockResolvedValue({ plan: paidPlan, mode: "INITIAL", token: paidToken });
    mocks.syncSubscription.mockResolvedValue(subscription({
      observedShopifyPlanHandle: "growth",
      planId: "paid-1",
      plan: paidPlan,
      billingPeriodId: "period-1",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      pendingShopifyPlanHandle: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
      nextReconcileAt: new Date("2026-09-30T00:00:00.000Z"),
    }));

    await runLoader("growth");

    expect(mocks.preparePaidActivation).toHaveBeenCalledWith("shop-1", "growth");
    expect(mocks.syncSubscription).toHaveBeenCalledWith("shop-1", paidToken);
    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.enqueueReconcile).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "subscription-1" }));
  });

  it("does not activate a pending paid handle when Shopify still reports another plan", async () => {
    mocks.prepareFreeActivation.mockResolvedValue(null);
    mocks.preparePaidActivation.mockResolvedValue({ plan: paidPlan, mode: "INITIAL", token: initialToken });
    mocks.getSubscriptionProjection.mockResolvedValue(subscription({
      observedShopifyPlanHandle: "starter",
      planId: "starter-1",
      plan: { kind: "PAID_METERED", shopifyPlanHandle: "starter" },
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: new Date(),
    }));

    await runLoader("growth");

    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalled();
  });

  it("keeps a Paid provider-null result on the existing bounded retry path", async () => {
    const paidToken = { ...initialToken, pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth" };
    mocks.prepareFreeActivation.mockResolvedValue(null);
    mocks.preparePaidActivation.mockResolvedValue({ plan: paidPlan, mode: "INITIAL", token: paidToken });
    mocks.syncSubscription.mockResolvedValue(null);

    await runLoader("growth");

    expect(mocks.syncSubscription).toHaveBeenCalledWith("shop-1", paidToken);
    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalledWith(expect.objectContaining({ expected: paidToken }));
    expect(mocks.enqueueReconcile).toHaveBeenCalled();
  });

  it("keeps a Paid Partner failure on the existing bounded retry path", async () => {
    const paidToken = { ...initialToken, pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth" };
    mocks.prepareFreeActivation.mockResolvedValue(null);
    mocks.preparePaidActivation.mockResolvedValue({ plan: paidPlan, mode: "INITIAL", token: paidToken });
    mocks.syncSubscription.mockRejectedValue(new Error("Partner unavailable"));

    await runLoader("growth");

    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      expected: paidToken,
      partnerErrorAt: expect.any(Date),
    }));
    expect(mocks.enqueueReconcile).toHaveBeenCalled();
  });

  it("does not enqueue the initial retry for an unsupported Paid trial", async () => {
    const paidToken = { ...initialToken, pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth" };
    mocks.prepareFreeActivation.mockResolvedValue(null);
    mocks.preparePaidActivation.mockResolvedValue({ plan: paidPlan, mode: "INITIAL", token: paidToken });
    mocks.syncSubscription.mockResolvedValue(subscription({
      status: "SYNC_ERROR",
      planId: null,
      observedShopifyPlanHandle: "growth",
      billingPeriodId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: paidToken.pendingEffectiveAt,
      nextReconcileAt: null,
      lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL",
    }));

    await runLoader("growth");

    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).not.toHaveBeenCalled();
    expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("does not classify a durable Paid configuration error as a Partner failure", async () => {
    const paidToken = { ...initialToken, pendingPlanId: "paid-1", pendingShopifyPlanHandle: "growth" };
    mocks.prepareFreeActivation.mockResolvedValue(null);
    mocks.preparePaidActivation.mockResolvedValue({ plan: paidPlan, mode: "INITIAL", token: paidToken });
    mocks.syncSubscription.mockResolvedValue(subscription({
      status: "SYNC_ERROR",
      planId: null,
      observedShopifyPlanHandle: "growth",
      billingPeriodId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: paidToken.pendingEffectiveAt,
      nextReconcileAt: null,
      lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION",
    }));

    await runLoader("growth");

    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).not.toHaveBeenCalled();
    expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it.each(["unknown", "paid"])("rejects %s handles before the Free activation path", async (planHandle) => {
    mocks.prepareFreeActivation.mockResolvedValue(null);
    mocks.recordReturn.mockResolvedValue({ result: "mismatch", subscriptionId: "subscription-1", nextReconcileAt: null });
    mocks.getState.mockResolvedValue({
      status: "ACTIVE_SUBSCRIPTION",
      subscription: {
        planHandle: "growth",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAtEndOfCycle: false,
        pendingUpdate: null,
      },
    });

    await runLoader(planHandle);

    expect(mocks.syncSubscription).not.toHaveBeenCalled();
    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(`/app/billing/options?plan_change=mismatch&requested_plan_handle=${planHandle}`);
  });

  it("keeps a pending callback unresolved until it becomes current", async () => {
    mocks.getSubscriptionProjection.mockResolvedValue(subscription({
      status: "NO_CONTRACT",
      planId: null,
      plan: null,
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: "free",
      pendingPlanId: "free-1",
      pendingEffectiveAt: new Date(),
    }));

    await runLoader("free");

    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1",
      expected: initialToken,
    }));
    expect(mocks.enqueueReconcile).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1",
      subscriptionId: "subscription-1",
    }));
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("preserves durable intent when Partner verification throws", async () => {
    mocks.syncSubscription.mockRejectedValue(new Error("Partner unavailable"));
    mocks.getSubscriptionProjection.mockResolvedValue(subscription({
      status: "NO_CONTRACT",
      planId: null,
      plan: null,
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: "free",
      pendingPlanId: "free-1",
      pendingEffectiveAt: new Date(),
    }));

    await runLoader("free");

    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      partnerErrorAt: expect.any(Date),
    }));
    expect(mocks.enqueueReconcile).toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("does not complete onboarding from stale active state after Partner failure", async () => {
    mocks.syncSubscription.mockRejectedValue(new Error("Partner unavailable"));
    mocks.getSubscriptionProjection.mockResolvedValue(subscription());

    await runLoader("free");

    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      partnerErrorAt: expect.any(Date),
    }));
    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("does not enqueue stale retry work when guarded scheduling loses the race", async () => {
    mocks.syncSubscription.mockRejectedValue(new Error("Partner unavailable"));
    mocks.scheduleInitialFreeReconciliationIfCurrent.mockResolvedValue(null);

    await runLoader("free");

    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalled();
    expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("does not complete an older callback when a newer Free selection is pending", async () => {
    mocks.getSubscriptionProjection.mockResolvedValue(subscription({
      plan: { id: "free-a-id", kind: "FREE", shopifyPlanHandle: "free-a" },
      observedShopifyPlanHandle: "free-a",
      planId: "free-a-id",
      pendingShopifyPlanHandle: "free-b",
      pendingPlanId: "free-b-id",
      pendingEffectiveAt: new Date(),
    }));

    await runLoader("free-a");

    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("keeps missing plan_handle as a client error", async () => {
    await expect(runLoader()).rejects.toMatchObject({ status: 400 });
    expect(mocks.prepareFreeActivation).not.toHaveBeenCalled();
  });
});

describe("hosted billing callback", () => {
  beforeEach(() => {
    mocks.prepareFreeActivation.mockResolvedValue(null);
    mocks.preparePaidActivation.mockResolvedValue(null);
  });

  it("requires plan_handle", async () => {
    await expect(runLoader()).rejects.toMatchObject({ status: 400 });
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it.each([["growth", "current"], ["free", "pending"], ["other", "mismatch"]])("classifies provider state: %s", async (handle, result) => {
    mocks.recordReturn.mockResolvedValue({ result, subscriptionId: "subscription-1", nextReconcileAt: new Date("2026-10-01T00:00:00.000Z") });
    await runLoader(handle);
    expect(mocks.getState).toHaveBeenCalledWith("shop-1");
    expect(mocks.recordReturn).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1",
      requestedPlanHandle: handle,
      verificationFence,
    }));
    const expectedRedirect = result === "mismatch"
      ? `/app/billing/options?plan_change=mismatch&requested_plan_handle=${handle}`
      : `/app/billing/options?plan_change=${result}`;
    expect(mocks.redirect).toHaveBeenCalledWith(expectedRedirect);
  });

  it("schedules reconciliation for verified current or pending state", async () => {
    await runLoader("free");
    expect(mocks.enqueueReconcile).toHaveBeenCalledWith(expect.objectContaining({ shopId: "shop-1", subscriptionId: "subscription-1" }));
    mocks.enqueueReconcile.mockClear();
    mocks.recordReturn.mockResolvedValue({ result: "mismatch", subscriptionId: "subscription-1", nextReconcileAt: new Date() });
    await runLoader("other");
    expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
  });

  it("does not enqueue a freshness-fenced unverified result", async () => {
    mocks.recordReturn.mockResolvedValue({ result: "unverified", subscriptionId: "subscription-1", nextReconcileAt: null });

    await runLoader("growth");

    expect(mocks.recordReturn).toHaveBeenCalledWith(expect.objectContaining({ verificationFence }));
    expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing/options?plan_change=unverified&requested_plan_handle=growth");
  });

  it("distinguishes no active subscription from verification failure", async () => {
    mocks.getState.mockResolvedValue({ status: "NO_ACTIVE_SUBSCRIPTION", subscription: null });
    mocks.recordReturn.mockResolvedValue({ result: "no_active", subscriptionId: "subscription-1", nextReconcileAt: new Date() });
    await runLoader("free");
    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing/options?plan_change=no_active");
    mocks.getState.mockRejectedValue(new Error("Partner unavailable"));
    await runLoader("free");
    expect(mocks.recordFailure).toHaveBeenCalledWith("shop-1", verificationFence);
    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing/options?plan_change=unverified&requested_plan_handle=free");
  });

  it("passes one read fence into provider failure recording", async () => {
    mocks.getState.mockRejectedValue(new Error("Partner unavailable"));

    await runLoader("growth");

    expect(mocks.getFence).toHaveBeenCalledBefore(mocks.getState);
    expect(mocks.recordFailure).toHaveBeenCalledWith("shop-1", verificationFence);
  });

  it("captures the durable hosted verification fence before the Partner read", async () => {
    await runLoader("growth");

    expect(mocks.getFence).toHaveBeenCalledBefore(mocks.getState);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.recordReturn).toHaveBeenCalledWith(expect.objectContaining({ verificationFence }));
  });

  it("passes the same durable hosted verification fence to provider failure recording", async () => {
    mocks.getState.mockRejectedValue(new Error("Partner unavailable"));

    await runLoader("growth");

    expect(mocks.getFence).toHaveBeenCalledBefore(mocks.getState);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.recordFailure).toHaveBeenCalledWith("shop-1", verificationFence);
  });

  it("passes an absent durable verification fence unchanged through hosted NO_ACTIVE verification", async () => {
    mocks.getFence.mockResolvedValue(null);
    mocks.getState.mockResolvedValue({ status: "NO_ACTIVE_SUBSCRIPTION", subscription: null });
    mocks.recordReturn.mockResolvedValue({ result: "no_active", subscriptionId: null, nextReconcileAt: null });

    await runLoader("growth");

    expect(mocks.getFence).toHaveBeenCalledBefore(mocks.getState);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.recordReturn).toHaveBeenCalledWith(expect.objectContaining({ verificationFence: null }));
    expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing/options?plan_change=no_active");
  });

  it("passes an absent durable verification fence unchanged to failure recording", async () => {
    mocks.getFence.mockResolvedValue(null);
    mocks.getState.mockRejectedValue(new Error("Partner unavailable"));

    await runLoader("growth");

    expect(mocks.getFence).toHaveBeenCalledBefore(mocks.getState);
    expect(mocks.getState).toHaveBeenCalledTimes(1);
    expect(mocks.recordFailure).toHaveBeenCalledWith("shop-1", null);
  });
});