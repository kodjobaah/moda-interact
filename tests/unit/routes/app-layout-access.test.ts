import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const readMerchantSupportUnreadCount = vi.fn();
const getSubscriptionProjection = vi.fn();

vi.mock("../../../app/services/shop/merchant-request-context.server", () => ({
  getMerchantRequestContext: async ({request}: {request: Request}) => {
    const authentication = await authenticateAdmin(request);
    const shop = await resolveShopifyShop({domain: authentication.session.shop});
    return {
      authentication, shop,
      readSubscription: () => getSubscriptionProjection(shop.id),
      readSettings: () => Promise.resolve(null),
    };
  },
  merchantPageContextMiddleware: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
  apiKey: "database-public-key",
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../../app/services/merchant-support/merchant-support.service", () => ({
  readMerchantSupportUnreadCount,
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: { getSubscriptionProjection },
}));

const { loader } = await import("../../../app/routes/app/route");

function requestFor(pathname: string) {
  return { request: new Request(`https://example.test${pathname}`) } as never;
}

async function expectRedirect(pathname: string, location: string) {
  try {
    await loader(requestFor(pathname));
    throw new Error("Expected loader to redirect");
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).headers.get("Location")).toBe(location);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    admin: { id: "shopify-admin" },
    session: { shop: "merchant.myshopify.com", locale: "en-GB" },
  });
  readMerchantSupportUnreadCount.mockResolvedValue(2);
  getSubscriptionProjection.mockResolvedValue(null);
});

describe("app layout access", () => {
  it.each(["/app", "/app/promotions", "/app/usage"])(
    "redirects pending reinstall before app-shell reads for product path: %s",
    async (pathname) => {
      resolveShopifyShop.mockResolvedValue({
        id: "shop-1",
        status: "UNINSTALLED",
        reinstallPendingAt: new Date("2026-09-14T00:00:00.000Z"),
      });

      await expectRedirect(pathname, "/app/reinstalling");
      expect(readMerchantSupportUnreadCount).not.toHaveBeenCalled();
    },
  );

  it("redirects suspended merchant before app-shell reads", async () => {
    resolveShopifyShop.mockResolvedValue({ id: "shop-1", status: "SUSPENDED" });

    await expectRedirect("/app/promotions", "/app/merchant-support");
    expect(readMerchantSupportUnreadCount).not.toHaveBeenCalled();
  });

  it("keeps pending reinstall merchant support reachable", async () => {
    resolveShopifyShop.mockResolvedValue({
      id: "shop-1",
      status: "UNINSTALLED",
      reinstallPendingAt: new Date("2026-09-14T00:00:00.000Z"),
    });

    await expect(loader(requestFor("/app/merchant-support?shopId=other-shop"))).resolves.toMatchObject({
      unreadMessages: 2,
      apiKey: "database-public-key",
    });
    expect(readMerchantSupportUnreadCount).toHaveBeenCalledWith({
      shopId: "shop-1",
    });
  });

  it("rejects unmarked uninstalled merchant support before app-shell reads", async () => {
    resolveShopifyShop.mockResolvedValue({ id: "shop-1", status: "UNINSTALLED", reinstallPendingAt: null });

    await expectRedirect("/app/merchant-support", "/auth/login");
    expect(readMerchantSupportUnreadCount).not.toHaveBeenCalled();
  });

  it("allows active merchant app shell", async () => {
    resolveShopifyShop.mockResolvedValue({
      id: "shop-1",
      status: "ACTIVE",
      onboardingCompleted: true,
    });
    getSubscriptionProjection.mockResolvedValue({ status: "ACTIVE" });

    await expect(loader(requestFor("/app"))).resolves.toMatchObject({
      unreadMessages: 2,
      merchantExperienceState: "ACTIVE",
    });
    expect(readMerchantSupportUnreadCount).toHaveBeenCalledWith({
      shopId: "shop-1",
    });
  });

  it("keeps a verified ended subscription in the merchant shell as post-contract", async () => {
    resolveShopifyShop.mockResolvedValue({
      id: "shop-1",
      status: "ACTIVE",
      onboardingCompleted: true,
    });
    getSubscriptionProjection.mockResolvedValue({
      status: "NO_CONTRACT",
      lastProviderLifecycleState: "CANCELED",
    });

    await expect(loader(requestFor("/app"))).resolves.toMatchObject({
      merchantExperienceState: "POST_CONTRACT",
    });
  });
});