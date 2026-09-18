import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  resolveShop: vi.fn(),
  getSubscription: vi.fn(),
  settingsFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  preferencesFindMany: vi.fn(),
  featureFindMany: vi.fn(),
  transactionFeatureFindUnique: vi.fn(),
  transactionSubscriptionFindUnique: vi.fn(),
  billingPlanFeatureFindUnique: vi.fn(),
  preferenceUpsert: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: mocks.resolveShop },
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: { getSubscription: mocks.getSubscription },
}));
vi.mock("../../../app/services/shop/shop-access-policy", () => ({
  assertActiveShop: vi.fn(),
}));
vi.mock("../../../app/db.server", () => ({
  default: {
    shopSettings: { findUnique: mocks.settingsFindUnique },
    subscription: { findUnique: mocks.subscriptionFindUnique },
    shopFeaturePreference: { findMany: mocks.preferencesFindMany },
    feature: { findMany: mocks.featureFindMany },
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      feature: { findUnique: mocks.transactionFeatureFindUnique },
      subscription: { findUnique: mocks.transactionSubscriptionFindUnique },
      billingPlanFeature: { findUnique: mocks.billingPlanFeatureFindUnique },
      shopFeaturePreference: { upsert: mocks.preferenceUpsert },
    })),
  },
}));

import { action, loader } from "../../../app/routes/app/features/route";

const shop = { id: "shop-1", status: "ACTIVE" };
const activeSubscription = { status: "ACTIVE" };
const alwaysEnabled = {
  id: "feature-1",
  key: "checkout_recovery",
  displayName: "Checkout Recovery",
  description: null,
  active: true,
  activationMode: "ALWAYS_ENABLED" as const,
};
const optionalFeature = {
  id: "feature-2",
  key: "ai_conversations",
  displayName: "AI Conversations",
  description: "Optional conversations",
  active: true,
  activationMode: "MERCHANT_OPT_IN" as const,
};

function post(featureKey: string, value: string, shopId = "ignored-shop") {
  return new Request("https://app.test/app/features", {
    method: "POST",
    body: new URLSearchParams({ intent: "set-feature-preference", featureKey, value, shopId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({ admin: {}, session: { shop: "example.myshopify.com" } });
  mocks.resolveShop.mockResolvedValue(shop);
  mocks.getSubscription.mockResolvedValue(activeSubscription);
  mocks.settingsFindUnique.mockResolvedValue({ onboardingCompleted: true });
  mocks.subscriptionFindUnique.mockResolvedValue({
    planId: "plan-1",
    plan: { features: [
      { featureId: alwaysEnabled.id, enabled: true, feature: alwaysEnabled },
      { featureId: optionalFeature.id, enabled: true, feature: optionalFeature },
    ] },
  });
  mocks.preferencesFindMany.mockResolvedValue([{ featureId: optionalFeature.id, enabled: false, feature: optionalFeature }]);
  mocks.featureFindMany.mockResolvedValue([alwaysEnabled, optionalFeature]);
  mocks.transactionFeatureFindUnique.mockResolvedValue(optionalFeature);
  mocks.transactionSubscriptionFindUnique.mockResolvedValue({ planId: "plan-1" });
  mocks.billingPlanFeatureFindUnique.mockResolvedValue({ enabled: true });
  mocks.preferenceUpsert.mockResolvedValue({});
});

describe("features route", () => {
  it("scopes every read to the authenticated shop and computes effective state", async () => {
    const result = await loader({ request: new Request("https://app.test/app/features") } as never);

    expect(result.features).toEqual([
      expect.objectContaining({ key: "checkout_recovery", supportedByCurrentPlan: true, preferenceEnabled: false, effectiveEnabled: true }),
      expect.objectContaining({ key: "ai_conversations", supportedByCurrentPlan: true, preferenceEnabled: false, effectiveEnabled: false }),
    ]);
    expect(mocks.subscriptionFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { shopId: "shop-1" } }));
    expect(mocks.preferencesFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shopId: "shop-1" } }));
  });

  it("rejects feature access for a tenant without an active mapped subscription", async () => {
    mocks.getSubscription.mockResolvedValue({ status: "NO_CONTRACT" });

    await expect(loader({ request: new Request("https://app.test/app/features") } as never)).rejects.toMatchObject({ status: 302 });
    expect(mocks.subscriptionFindUnique).not.toHaveBeenCalled();
  });

  it("enables and disables a supported merchant opt-in without accepting browser shop identity", async () => {
    await action({ request: post("ai_conversations", "true") } as never);
    expect(mocks.transactionFeatureFindUnique).toHaveBeenCalledWith({ where: { key: "ai_conversations" } });
    expect(mocks.transactionSubscriptionFindUnique).toHaveBeenCalledWith({ where: { shopId: "shop-1" }, select: { planId: true } });
    expect(mocks.preferenceUpsert).toHaveBeenCalledWith({
      where: { shopId_featureId: { shopId: "shop-1", featureId: "feature-2" } },
      update: { enabled: true },
      create: { shopId: "shop-1", featureId: "feature-2", enabled: true },
    });

    await action({ request: post("ai_conversations", "false") } as never);
    expect(mocks.preferenceUpsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: { enabled: false }, create: { shopId: "shop-1", featureId: "feature-2", enabled: false } }));
  });

  it("rejects always-enabled, unsupported, and inactive feature preferences", async () => {
    mocks.transactionFeatureFindUnique.mockResolvedValueOnce(alwaysEnabled);
    await expect(action({ request: post("checkout_recovery", "false") } as never)).rejects.toMatchObject({ status: 400 });

    mocks.transactionFeatureFindUnique.mockResolvedValueOnce(optionalFeature);
    mocks.billingPlanFeatureFindUnique.mockResolvedValueOnce({ enabled: false });
    await expect(action({ request: post("ai_conversations", "true") } as never)).rejects.toMatchObject({ status: 400 });

    mocks.transactionFeatureFindUnique.mockResolvedValueOnce({ ...optionalFeature, active: false });
    await expect(action({ request: post("ai_conversations", "true") } as never)).rejects.toMatchObject({ status: 400 });
    expect(mocks.preferenceUpsert).toHaveBeenCalledTimes(0);
  });
});