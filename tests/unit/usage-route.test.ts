import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const getSubscription = vi.fn();
const findShopSettings = vi.fn();
const findBillingPeriods = vi.fn();
const findRecoveries = vi.fn();
const findUsageEvents = vi.fn();
const countUsageEvents = vi.fn();
const aggregateUsageEvents = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../app/services/billing/billing.service", () => ({
  billingService: { getSubscription },
}));
vi.mock("../../app/db.server", () => ({
  default: {
    shopSettings: { findUnique: findShopSettings },
    billingPeriod: { findMany: findBillingPeriods },
    checkoutRecovery: { findMany: findRecoveries },
    usageEvent: {
      findMany: findUsageEvents,
      count: countUsageEvents,
      aggregate: aggregateUsageEvents,
    },
  },
}));

const { loader } = await import("../../app/routes/app/usage/route");

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    admin: { id: "shopify-admin" },
    session: { shop: "merchant.myshopify.com" },
  });
  resolveShopifyShop.mockResolvedValue({
    id: "shop-1",
    status: "ACTIVE",
  });
  findShopSettings.mockResolvedValue({ onboardingCompleted: false });
  findBillingPeriods.mockResolvedValue([]);
  findRecoveries.mockResolvedValue([]);
  findUsageEvents.mockResolvedValue([]);
  countUsageEvents.mockResolvedValue(0);
  aggregateUsageEvents.mockResolvedValue({ _sum: { quantity: null } });
});

describe("usage route loader", () => {
  it("redirects incomplete onboarding back to app", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: false });
    getSubscription.mockResolvedValue({ status: "ACTIVE" });

    try {
      await loader({
        request: new Request("https://example.test/app/usage"),
      });
      throw new Error("Expected usage loader to redirect");
    } catch (error) {
      const response = error as Response;
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/app");
    }
  });

  it("allows historical usage for an onboarded no-contract shop", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscription.mockResolvedValue({ status: "NO_CONTRACT" });

    await expect(loader({ request: new Request("https://example.test/app/usage") })).resolves.toMatchObject({
      usageEvents: [],
      usagePagination: { total: 0 },
    });
    expect(findUsageEvents).toHaveBeenCalled();
  });
});
