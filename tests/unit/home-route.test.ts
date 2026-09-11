import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const getSubscription = vi.fn();
const findShopSettings = vi.fn();
const readPendingRecoveries = vi.fn();
const findRecoveries = vi.fn();
const findBillingPeriods = vi.fn();
const findUsageEvents = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../app/services/billing/billing.service", () => ({
  billingService: { getSubscription },
}));
vi.mock("../../app/services/pending-recovery/pending-recovery-reader.server", () => ({
  readPendingRecoveries,
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
});

describe("app home loader", () => {
  it("returns onboarding data without loading dashboard datasets", async () => {
    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      settings: { onboardingCompleted: false },
      subscription: null,
    });
    expect(getSubscription).not.toHaveBeenCalled();
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("returns onboarding data for a completed shop without an active plan", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscription.mockResolvedValue({ status: "NO_CONTRACT" });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      settings: { onboardingCompleted: true },
      subscription: null,
    });
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });
});
