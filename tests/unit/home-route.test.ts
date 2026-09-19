import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const getSubscription = vi.fn();
const getSubscriptionProjection = vi.fn();
const getMerchantRecoveryCapacityState = vi.fn();
const findShopSettings = vi.fn();
const readPendingRecoveries = vi.fn();
const findRecoveries = vi.fn();
const findBillingPeriods = vi.fn();
const findUsageEvents = vi.fn();
const readActiveMerchantPricingCatalogue = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../app/services/billing/billing.service", () => ({
  billingService: { getSubscription, getSubscriptionProjection, getMerchantRecoveryCapacityState },
}));
vi.mock("../../app/services/pending-recovery/pending-recovery-reader.server", () => ({
  readPendingRecoveries,
}));
vi.mock("../../app/services/merchant-pricing/merchant-pricing.server", () => ({
  readActiveMerchantPricingCatalogue,
}));
vi.mock("../../app/db.server", () => ({
  default: {
    shopSettings: { findUnique: findShopSettings },
    checkoutRecovery: { findMany: findRecoveries },
    billingPeriod: { findMany: findBillingPeriods },
    usageEvent: { findMany: findUsageEvents },
  },
}));

const { loader } = await import("../../app/routes/app/home/route");

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    admin: { id: "shopify-admin" },
    session: { shop: "merchant.myshopify.com", locale: "en-GB" },
  });
  resolveShopifyShop.mockResolvedValue({
    id: "shop-1",
    domain: "merchant.myshopify.com",
    status: "ACTIVE",
  });
  findShopSettings.mockResolvedValue({ onboardingCompleted: false });
  getMerchantRecoveryCapacityState.mockResolvedValue({ availability: "CONTRACT_REQUIRED", observedShopifyPlanHandle: null });
  getSubscriptionProjection.mockResolvedValue(null);
  readPendingRecoveries.mockResolvedValue({ available: true, items: [] });
  readActiveMerchantPricingCatalogue.mockResolvedValue([]);
  findRecoveries.mockResolvedValue([]);
  findBillingPeriods.mockResolvedValue([]);
  findUsageEvents.mockResolvedValue([]);
});

describe("app home loader", () => {
  it("returns onboarding data without loading dashboard datasets", async () => {
    readActiveMerchantPricingCatalogue.mockResolvedValue([{ shopifyPlanHandle: "free" }]);
    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      settings: { onboardingCompleted: false },
      merchantExperienceState: "ONBOARDING",
      pricingCatalogue: [{ shopifyPlanHandle: "free" }],
      subscription: null,
    });
    expect(getSubscription).not.toHaveBeenCalled();
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("keeps detail requests on the onboarding surface", async () => {
    const result = await loader({
      request: new Request("https://example.test/app?view=detail"),
    });

    expect(result).toMatchObject({
      merchantExperienceState: "ONBOARDING",
      subscription: null,
    });
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("shows subscription setup instead of plan selection once durable Shopify evidence exists", async () => {
    readActiveMerchantPricingCatalogue.mockResolvedValue([{
      shopifyPlanHandle: "free",
      displayName: "Free",
    }]);
    getSubscriptionProjection.mockResolvedValue({
      status: "UNMAPPED",
      observedShopifyPlanHandle: "free",
      pendingShopifyPlanHandle: null,
      providerSubscriptionId: "gid://shopify/AppSubscription/1",
      currentPeriodStart: new Date("2026-09-18T21:20:00.000Z"),
      currentPeriodEnd: new Date("2026-10-18T21:20:00.000Z"),
      lastSyncedAt: new Date("2026-09-18T21:45:40.710Z"),
    });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      settings: { onboardingCompleted: false },
      merchantExperienceState: "ONBOARDING",
      billingSetup: {
        phase: "FINALIZING_SUBSCRIPTION",
        planHandle: "free",
        planName: "Free",
        currentPeriodStart: "2026-09-18T21:20:00.000Z",
        currentPeriodEnd: "2026-10-18T21:20:00.000Z",
      },
      subscription: null,
    });
    expect(getMerchantRecoveryCapacityState).not.toHaveBeenCalled();
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("keeps a completed shop without an active plan on the merchant surface", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscriptionProjection.mockResolvedValue({
      status: "NO_CONTRACT",
      plan: null,
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: null,
    });
    readActiveMerchantPricingCatalogue.mockResolvedValue([{ shopifyPlanHandle: "database-plan" }]);

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      settings: { onboardingCompleted: true },
      merchantExperienceState: "NO_CONTRACT",
      subscription: { status: "NO_CONTRACT" },
      pricingCatalogue: [{ shopifyPlanHandle: "database-plan" }],
      capacity: { availability: "CONTRACT_REQUIRED" },
    });
    expect(findRecoveries).toHaveBeenCalled();
    expect(findBillingPeriods).toHaveBeenCalled();
    expect(findUsageEvents).toHaveBeenCalled();
  });

  it("preserves pending plan and scheduled cancellation precedence in dashboard data", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscription.mockResolvedValue({
      status: "ACTIVE",
      observedShopifyPlanHandle: "growth",
    });
    getSubscriptionProjection.mockResolvedValue({
      status: "ACTIVE",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      pendingEffectiveAt: new Date("2026-09-20T00:00:00.000Z"),
      pendingPlan: { name: "Basic" },
    });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result.subscription).toMatchObject({
      status: "ACTIVE",
      cancelAtEndOfCycle: true,
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      pendingPlan: {
        name: "Basic",
        effectiveAt: "2026-09-20T00:00:00.000Z",
      },
    });
  });

  it("keeps historical dashboard data readable without reading pending recoveries for denied states", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscriptionProjection.mockResolvedValue({ status: "NO_CONTRACT" });
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "CONTRACT_FROZEN",
      canStartRecovery: false,
    });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      subscription: { status: "NO_CONTRACT" },
      capacity: { availability: "CONTRACT_FROZEN", canStartRecovery: false },
      pendingRecoveries: {
        available: false,
        page: 1,
        pageSize: 10,
        total: 0,
        totalPages: 0,
        items: [],
      },
    });
    expect(readPendingRecoveries).not.toHaveBeenCalled();
  });

  it("keeps billing-attention history readable while exposing setup state", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    readActiveMerchantPricingCatalogue.mockResolvedValue([{
      shopifyPlanHandle: "free",
      displayName: "Free",
    }]);
    getSubscriptionProjection.mockResolvedValue({
      status: "UNMAPPED",
      observedShopifyPlanHandle: "free",
      providerSubscriptionId: "gid://shopify/AppSubscription/1",
      currentPeriodStart: new Date("2026-09-18T21:20:00.000Z"),
      currentPeriodEnd: new Date("2026-10-18T21:20:00.000Z"),
      lastSyncedAt: new Date("2026-09-18T21:45:40.710Z"),
    });
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "CONFIGURATION_UNAVAILABLE",
      observedShopifyPlanHandle: "free",
    });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      merchantExperienceState: "BILLING_ATTENTION",
      billingSetup: {
        phase: "FINALIZING_SUBSCRIPTION",
        planName: "Free",
      },
      capacity: { availability: "CONFIGURATION_UNAVAILABLE" },
      pendingRecoveries: { available: false, items: [] },
    });
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).toHaveBeenCalled();
    expect(findBillingPeriods).toHaveBeenCalled();
    expect(findUsageEvents).toHaveBeenCalled();
  });

  it("redirects pending reinstall before reading product data", async () => {
    resolveShopifyShop.mockResolvedValue({
      id: "shop-1",
      domain: "merchant.myshopify.com",
      status: "UNINSTALLED",
      reinstallPendingAt: new Date("2026-09-14T00:00:00.000Z"),
    });

    await expect(loader({
      request: new Request("https://example.test/app"),
    })).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(Response);
      expect(error.headers.get("Location")).toBe("/app/reinstalling");
      return true;
    });

    expect(findShopSettings).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });
});
