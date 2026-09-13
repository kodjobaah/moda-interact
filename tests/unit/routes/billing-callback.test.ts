import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  redirect: vi.fn((location: string) => ({ location })),
  resolveShop: vi.fn(),
  prepareFreeActivation: vi.fn(),
  preparePaidActivation: vi.fn(),
  syncSubscription: vi.fn(),
  getSubscriptionProjection: vi.fn(),
  completeFreeActivation: vi.fn(),
  completePaidActivation: vi.fn(),
  scheduleInitialFreeReconciliationIfCurrent: vi.fn(),
  enqueueReconcile: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: {
    prepareFreeActivation: mocks.prepareFreeActivation,
    preparePaidActivation: mocks.preparePaidActivation,
    syncSubscription: mocks.syncSubscription,
    getSubscriptionProjection: mocks.getSubscriptionProjection,
    completeFreeActivation: mocks.completeFreeActivation,
    completePaidActivation: mocks.completePaidActivation,
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
  mocks.prepareFreeActivation.mockResolvedValue({
    plan: freePlan,
    mode: "INITIAL",
    token: initialToken,
  });
  mocks.preparePaidActivation.mockResolvedValue(null);
  mocks.syncSubscription.mockResolvedValue(subscription());
  mocks.getSubscriptionProjection.mockResolvedValue(subscription());
  mocks.completeFreeActivation.mockResolvedValue({
    subscriptionId: "subscription-1",
    nextReconcileAt: null,
  });
  mocks.completePaidActivation.mockResolvedValue({
    subscriptionId: "subscription-1",
    nextReconcileAt: new Date("2026-09-30T00:00:00.000Z"),
  });
  mocks.scheduleInitialFreeReconciliationIfCurrent.mockResolvedValue({
    subscriptionId: "subscription-1",
    nextReconcileAt: new Date("2026-09-12T00:01:00.000Z"),
  });
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
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: paidToken.pendingEffectiveAt,
    }));
    mocks.getSubscriptionProjection.mockResolvedValue(subscription({
      observedShopifyPlanHandle: "growth",
      planId: "paid-1",
      plan: paidPlan,
      pendingShopifyPlanHandle: "growth",
      pendingPlanId: "paid-1",
      pendingEffectiveAt: paidToken.pendingEffectiveAt,
    }));

    await runLoader("growth");

    expect(mocks.preparePaidActivation).toHaveBeenCalledWith("shop-1", "growth");
    expect(mocks.completePaidActivation).toHaveBeenCalledWith("shop-1", "growth");
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

    expect(mocks.completePaidActivation).not.toHaveBeenCalled();
    expect(mocks.scheduleInitialFreeReconciliationIfCurrent).toHaveBeenCalled();
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