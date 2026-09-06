import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const readMerchantSupportMessages = vi.fn();
const composeMerchantMessage = vi.fn();
const markMerchantSupportMessageRead = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../app/services/merchant-support/merchant-support.service", () => ({
  readMerchantSupportMessages,
  composeMerchantMessage,
  markMerchantSupportMessageRead,
}));

const { action, loader } = await import("../../app/routes/app.merchant-support");

describe("merchant support resource route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdmin.mockResolvedValue({
      admin: { id: "shopify-admin" },
      session: { shop: "merchant.myshopify.com", userId: "user-1" },
    });
    resolveShopifyShop.mockResolvedValue({
      id: "internal-shop-1",
      domain: "merchant.myshopify.com",
    });
    readMerchantSupportMessages.mockResolvedValue({ items: [] });
    composeMerchantMessage.mockResolvedValue({ messageId: "message-1", translationId: null });
    markMerchantSupportMessageRead.mockResolvedValue(true);
  });

  it("derives the tenant from authenticated Shopify context", async () => {
    await loader({
      request: new Request("https://example.test/app/merchant-support?page=2&shopId=other-shop"),
    });

    expect(resolveShopifyShop).toHaveBeenCalledWith({
      admin: { id: "shopify-admin" },
      domain: "merchant.myshopify.com",
    });
    expect(readMerchantSupportMessages).toHaveBeenCalledWith({
      shopId: "internal-shop-1",
      page: 2,
      pageSize: 25,
    });
  });

  it("does not accept client-controlled shop or message provenance", async () => {
    const form = new FormData();
    form.set("intent", "compose");
    form.set("body", "Hello support");
    form.set("shopId", "other-shop");
    form.set("kind", "SYSTEM");
    form.set("state", "AVAILABLE");

    await action({
      request: new Request("https://example.test/app/merchant-support", {
        method: "POST",
        body: form,
      }),
    });

    expect(composeMerchantMessage).toHaveBeenCalledWith({
      shopId: "internal-shop-1",
      body: "Hello support",
      shopifyUserId: "user-1",
    });
    expect(composeMerchantMessage.mock.calls[0]?.[0]).not.toHaveProperty("kind");
    expect(composeMerchantMessage.mock.calls[0]?.[0]).not.toHaveProperty("state");
  });

  it("verifies the tenant before marking a message read", async () => {
    const form = new FormData();
    form.set("intent", "read");
    form.set("messageId", "message-1");
    form.set("shopId", "other-shop");

    await action({
      request: new Request("https://example.test/app/merchant-support", {
        method: "POST",
        body: form,
      }),
    });

    expect(markMerchantSupportMessageRead).toHaveBeenCalledWith({
      shopId: "internal-shop-1",
      messageId: "message-1",
    });
  });
});