import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));

const { loader } = await import("../../../app/routes/app/additional/route");

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    admin: { id: "shopify-admin" },
    session: { shop: "merchant.myshopify.com" },
  });
});

describe("additional route access", () => {
  it("redirects pending reinstall before rendering the product page", async () => {
    resolveShopifyShop.mockResolvedValue({
      id: "shop-1",
      status: "UNINSTALLED",
      reinstallPendingAt: new Date("2026-09-14T00:00:00.000Z"),
    });

    await expect(loader({ request: new Request("https://example.test/app/additional") } as never)).rejects.toMatchObject({
      headers: expect.any(Headers),
    });
  });

  it("allows an active shop", async () => {
    resolveShopifyShop.mockResolvedValue({ id: "shop-1", status: "ACTIVE" });
    await expect(loader({ request: new Request("https://example.test/app/additional") } as never)).resolves.toBeNull();
  });
});