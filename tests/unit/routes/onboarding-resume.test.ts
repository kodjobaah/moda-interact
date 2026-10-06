import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  resolveShop: vi.fn(),
  assertActiveShop: vi.fn(),
  getSubscriptionProjection: vi.fn(),
  syncSubscription: vi.fn(),
  activateInitialCategory: vi.fn(),
  transaction: vi.fn(),
  updateShopOnboarding: vi.fn(),
  updateSettingsOnboarding: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: mocks.resolveShop },
}));
vi.mock("../../../app/services/shop/shop-access-policy", () => ({
  assertActiveShop: mocks.assertActiveShop,
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: {
    getSubscriptionProjection: mocks.getSubscriptionProjection,
    syncSubscription: mocks.syncSubscription,
  },
}));
vi.mock("../../../app/services/store-profile/store-category-activation.server", () => ({
  activateInitialPendingStoreCategoryIfEligible: mocks.activateInitialCategory,
}));
vi.mock("../../../app/db.server", () => ({
  default: { $transaction: mocks.transaction },
}));

import { action } from "../../../app/routes/app/onboarding/resume/route";

function request(generation = "7") {
  return new Request("https://app.test/app/onboarding/resume", {
    method: "POST",
    body: new URLSearchParams({ expectedPendingSelectionGeneration: generation }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({
    admin: {},
    session: { shop: "merchant.myshopify.com" },
  });
  mocks.resolveShop.mockResolvedValue({
    id: "shop-1",
    domain: "merchant.myshopify.com",
    status: "ACTIVE",
    onboardingCompleted: false,
  });
  mocks.getSubscriptionProjection.mockResolvedValue({
    status: "UNMAPPED",
    observedShopifyPlanHandle: "free",
    pendingShopifyPlanHandle: null,
    providerSubscriptionId: "gid://shopify/AppSubscription/1",
  });
  mocks.syncSubscription.mockResolvedValue({
    status: "ACTIVE",
    planId: "plan-free",
  });
  mocks.activateInitialCategory.mockResolvedValue({
    kind: "ACTIVATED",
    categoryId: "category-1",
    promptRevisionId: "revision-1",
  });
  mocks.transaction.mockImplementation(async (callback) => callback({
    shop: { updateMany: mocks.updateShopOnboarding },
    shopSettings: { updateMany: mocks.updateSettingsOnboarding },
  }));
  mocks.updateShopOnboarding.mockResolvedValue({ count: 1 });
  mocks.updateSettingsOnboarding.mockResolvedValue({ count: 1 });
});

describe("onboarding resume action", () => {
  it("re-syncs an existing Shopify subscription, activates the pending Store Category, and completes onboarding", async () => {
    const response = await action({ request: request() } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, onboardingCompleted: true });
    expect(mocks.syncSubscription).toHaveBeenCalledWith("shop-1");
    expect(mocks.activateInitialCategory).toHaveBeenCalledWith({
      shopId: "shop-1",
      expectedPendingSelectionGeneration: 7,
    });
    expect(mocks.updateShopOnboarding).toHaveBeenCalledWith({
      where: { id: "shop-1" },
      data: { onboardingCompleted: true },
    });
    expect(mocks.updateSettingsOnboarding).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: { onboardingCompleted: true },
    });
  });

  it("does not complete onboarding when the provider subscription cannot be mapped to an active local plan", async () => {
    mocks.syncSubscription.mockResolvedValue({
      status: "UNMAPPED",
      planId: null,
    });

    const response = await action({ request: request() } as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "BILLING_RECONCILIATION_REQUIRED",
    });
    expect(mocks.activateInitialCategory).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not call Shopify when there is no durable subscription evidence to resume", async () => {
    mocks.getSubscriptionProjection.mockResolvedValue(null);

    const response = await action({ request: request() } as never);

    expect(response.status).toBe(409);
    expect(mocks.syncSubscription).not.toHaveBeenCalled();
    expect(mocks.activateInitialCategory).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
