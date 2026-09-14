import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  redirect: vi.fn((location: string) => ({ location })),
  resolveShop: vi.fn(),
  getState: vi.fn(),
  recordReturn: vi.fn(),
  recordFailure: vi.fn(),
  prepareFreeActivation: vi.fn(),
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
    getMerchantShopifySubscriptionState: mocks.getState,
    recordHostedPlanChangeReturn: mocks.recordReturn,
    recordHostedPlanVerificationFailure: mocks.recordFailure,
  },
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
const initialToken = Object.freeze({
  subscriptionId: "subscription-1",
  pendingPlanId: "free-1",
  pendingShopifyPlanHandle: "free",
  pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
  nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
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
  mocks.recordReturn.mockResolvedValue({ result: "pending", subscriptionId: "subscription-1", nextReconcileAt: new Date("2026-10-01T00:00:00.000Z") });
  mocks.recordFailure.mockResolvedValue({ subscriptionId: "subscription-1", nextReconcileAt: new Date("2026-09-12T00:01:00.000Z") });
});

describe.skip("legacy billing callback activation", () => {
  it("completes onboarding only after current Free verification", async () => {
    await runLoader("free");

    expect(mocks.prepareFreeActivation).toHaveBeenCalledWith("shop-1", "free");
    expect(mocks.syncSubscription).toHaveBeenCalledWith("shop-1", initialToken);
    expect(mocks.completeFreeActivation).toHaveBeenCalledWith("shop-1", "free");
    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it.each(["unknown", "paid"])("rejects %s handles before the Free activation path", async (planHandle) => {
    mocks.prepareFreeActivation.mockResolvedValue(null);

    await runLoader(planHandle);

    expect(mocks.syncSubscription).not.toHaveBeenCalled();
    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
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
  it("requires plan_handle", async () => {
    await expect(runLoader()).rejects.toMatchObject({ status: 400 });
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it.each([["growth", "current"], ["free", "pending"], ["other", "mismatch"]])("classifies provider state: %s", async (handle, result) => {
    mocks.recordReturn.mockResolvedValue({ result, subscriptionId: "subscription-1", nextReconcileAt: new Date("2026-10-01T00:00:00.000Z") });
    await runLoader(handle);
    expect(mocks.getState).toHaveBeenCalledWith("shop-1");
    expect(mocks.recordReturn).toHaveBeenCalledWith(expect.objectContaining({ shopId: "shop-1", requestedPlanHandle: handle }));
    expect(mocks.redirect).toHaveBeenCalledWith(`/app/billing/options?plan_change=${result}`);
  });

  it("schedules reconciliation for verified current or pending state", async () => {
    await runLoader("free");
    expect(mocks.enqueueReconcile).toHaveBeenCalledWith(expect.objectContaining({ shopId: "shop-1", subscriptionId: "subscription-1" }));
    mocks.enqueueReconcile.mockClear();
    mocks.recordReturn.mockResolvedValue({ result: "mismatch", subscriptionId: "subscription-1", nextReconcileAt: new Date() });
    await runLoader("other");
    expect(mocks.enqueueReconcile).not.toHaveBeenCalled();
  });

  it("distinguishes no active subscription from verification failure", async () => {
    mocks.getState.mockResolvedValue({ status: "NO_ACTIVE_SUBSCRIPTION", subscription: null });
    mocks.recordReturn.mockResolvedValue({ result: "no_active", subscriptionId: "subscription-1", nextReconcileAt: new Date() });
    await runLoader("free");
    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing/options?plan_change=no_active");
    mocks.getState.mockRejectedValue(new Error("Partner unavailable"));
    await runLoader("free");
    expect(mocks.recordFailure).toHaveBeenCalledWith("shop-1");
    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing/options?plan_change=unverified");
  });
});