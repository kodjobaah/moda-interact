import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  resolveShop: vi.fn(),
  getSubscriptionProjection: vi.fn(),
  assertActiveShop: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("../../../app/db.server", () => ({ default: {} }));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: mocks.resolveShop },
}));
vi.mock("../../../app/services/shop/shop-access-policy", () => ({
  assertActiveShop: mocks.assertActiveShop,
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: { getSubscriptionProjection: mocks.getSubscriptionProjection },
}));

import { loader } from "../../../app/routes/app/billing/status/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({
    admin: {},
    session: { shop: "merchant.myshopify.com" },
  });
  mocks.resolveShop.mockResolvedValue({
    id: "shop-1",
    status: "ACTIVE",
    onboardingCompleted: false,
  });
  mocks.getSubscriptionProjection.mockResolvedValue({
    status: "UNMAPPED",
    observedShopifyPlanHandle: "free",
  });
});

describe("billing status onboarding source", () => {
  it("uses the shared Shop milestone when deciding whether setup is required", async () => {
    const response = await loader({
      request: new Request("https://example.test/app/billing/status"),
    } as never);

    expect(await response.json()).toMatchObject({ requiresSetupScreen: true });
    expect(mocks.getSubscriptionProjection).toHaveBeenCalledWith("shop-1");
  });

  it("does not require setup for a completed shared Shop with an active subscription", async () => {
    mocks.resolveShop.mockResolvedValue({
      id: "shop-1",
      status: "ACTIVE",
      onboardingCompleted: true,
    });
    mocks.getSubscriptionProjection.mockResolvedValue({ status: "ACTIVE" });

    const response = await loader({
      request: new Request("https://example.test/app/billing/status"),
    } as never);

    expect(await response.json()).toMatchObject({ requiresSetupScreen: false });
  });
});