import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const readPendingRecoveries = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../app/services/pending-recovery/pending-recovery-reader.server", () => ({
  readPendingRecoveries,
}));

const { loader } = await import("../../app/routes/app.pending-recoveries");

describe("pending recoveries resource loader", () => {
  beforeEach(() => {
    authenticateAdmin.mockResolvedValue({
      admin: { id: "shopify-admin" },
      session: { shop: "Merchant.MyShopify.com" },
    });
    resolveShopifyShop.mockResolvedValue({
      id: "internal-shop-1",
      domain: "merchant.myshopify.com",
    });
    readPendingRecoveries.mockResolvedValue({
      available: true,
      page: 2,
      pageSize: 10,
      total: 11,
      totalPages: 2,
      items: [],
    });
  });

  it("refreshes only the authenticated shop's pending data", async () => {
    const response = await loader({
      request: new Request("https://example.test/app/pending-recoveries?pendingPage=2&shopId=other-shop"),
    });

    expect(resolveShopifyShop).toHaveBeenCalledWith({
      admin: { id: "shopify-admin" },
      domain: "Merchant.MyShopify.com",
    });
    expect(readPendingRecoveries).toHaveBeenCalledWith({
      shopId: "internal-shop-1",
      shopDomain: "merchant.myshopify.com",
      page: 2,
    });
    expect(response.pendingRecoveries).toMatchObject({ page: 2, total: 11 });
    expect(response.refreshedAt).toEqual(expect.any(String));
  });
});
