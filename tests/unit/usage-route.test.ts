import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const getSubscription = vi.fn();
const findShopSettings = vi.fn();

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
  default: { shopSettings: { findUnique: findShopSettings } },
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
});

describe("usage route loader", () => {
  it.each([
    ["incomplete onboarding", { onboardingCompleted: false }, { status: "ACTIVE" }],
    ["no contract", { onboardingCompleted: true }, { status: "NO_CONTRACT" }],
  ])("redirects %s back to app", async (_label, settings, subscription) => {
    findShopSettings.mockResolvedValue(settings);
    getSubscription.mockResolvedValue(subscription);

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
});
