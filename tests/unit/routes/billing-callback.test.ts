import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  redirect: vi.fn((location: string) => ({ location })),
  resolveShop: vi.fn(),
  prepareFreeActivation: vi.fn(),
  syncSubscription: vi.fn(),
  recordPartnerSyncError: vi.fn(),
  getSubscriptionProjection: vi.fn(),
  completeFreeActivation: vi.fn(),
  scheduleInitialFreeReconciliation: vi.fn(),
  enqueueReconcile: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: {
    prepareFreeActivation: mocks.prepareFreeActivation,
    syncSubscription: mocks.syncSubscription,
    recordPartnerSyncError: mocks.recordPartnerSyncError,
    getSubscriptionProjection: mocks.getSubscriptionProjection,
    completeFreeActivation: mocks.completeFreeActivation,
    scheduleInitialFreeReconciliation: mocks.scheduleInitialFreeReconciliation,
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
  mocks.prepareFreeActivation.mockResolvedValue({ plan: freePlan });
  mocks.syncSubscription.mockResolvedValue(subscription());
  mocks.getSubscriptionProjection.mockResolvedValue(subscription());
  mocks.completeFreeActivation.mockResolvedValue(true);
  mocks.scheduleInitialFreeReconciliation.mockResolvedValue({
    id: "subscription-1",
  });
});

describe("billing callback activation", () => {
  it("completes onboarding only after current Free verification", async () => {
    await runLoader("free");

    expect(mocks.prepareFreeActivation).toHaveBeenCalledWith("shop-1", "free");
    expect(mocks.completeFreeActivation).toHaveBeenCalledWith("shop-1", "free");
    expect(mocks.scheduleInitialFreeReconciliation).not.toHaveBeenCalled();
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
    expect(mocks.scheduleInitialFreeReconciliation).toHaveBeenCalledWith("shop-1", expect.any(Date));
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

    expect(mocks.scheduleInitialFreeReconciliation).toHaveBeenCalled();
    expect(mocks.enqueueReconcile).toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("does not complete onboarding from stale active state after Partner failure", async () => {
    mocks.syncSubscription.mockRejectedValue(new Error("Partner unavailable"));
    mocks.getSubscriptionProjection.mockResolvedValue(subscription());

    await runLoader("free");

    expect(mocks.recordPartnerSyncError).toHaveBeenCalledWith("shop-1", expect.any(Date));
    expect(mocks.completeFreeActivation).not.toHaveBeenCalled();
    expect(mocks.scheduleInitialFreeReconciliation).toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
  });

  it("keeps missing plan_handle as a client error", async () => {
    await expect(runLoader()).rejects.toMatchObject({ status: 400 });
    expect(mocks.prepareFreeActivation).not.toHaveBeenCalled();
  });
});