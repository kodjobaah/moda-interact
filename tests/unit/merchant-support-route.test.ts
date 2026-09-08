import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const readMerchantSupportMessages = vi.fn();
const composeMerchantMessage = vi.fn();
const markMerchantSupportMessageRead = vi.fn();
const merchantSupportRouteSource = await readFile(
  new URL("../../app/routes/app.merchant-support.jsx", import.meta.url),
  "utf8",
);

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

const { action, loader, countGraphemes, markUnreadMessages } = await import("../../app/routes/app.merchant-support");

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

  it("counts user-perceived graphemes instead of UTF-16 code units", () => {
    expect(countGraphemes("👩‍💻".repeat(500))).toBe(500);
    expect(countGraphemes("👩‍💻".repeat(501))).toBe(501);
  });

  it("uses Shared grapheme counting and bounded shell revalidation after reads", () => {
    expect(merchantSupportRouteSource).toContain("countUnicodeGraphemes");
    expect(merchantSupportRouteSource).toContain("export const countGraphemes = countUnicodeGraphemes;");
    expect(merchantSupportRouteSource).toContain("if (unreadIds.length === 0) return false;");
    expect(merchantSupportRouteSource).toContain("result?.marked !== true");
    expect(merchantSupportRouteSource).toContain("[unreadMessageIds, revalidate]");
  });

  it("renders billing CTAs from system metadata rather than translated body URLs", () => {
    expect(merchantSupportRouteSource).toContain("getMerchantSystemMessageAction");
    expect(merchantSupportRouteSource).toContain('message.kind === "SYSTEM"');
    expect(merchantSupportRouteSource).not.toContain('message.originalBody.includes("http");');
  });

  it("does not post or revalidate when there are no unread IDs", async () => {
    const fetchImpl = vi.fn();
    const revalidate = vi.fn();

    await expect(markUnreadMessages({ messageIds: [], fetchImpl, revalidate })).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("posts each unread ID and revalidates exactly once after successful reads", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ marked: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ marked: true }), { status: 200 }));
    const revalidate = vi.fn();

    await expect(markUnreadMessages({
      messageIds: ["message-1", "message-2"],
      fetchImpl,
      revalidate,
    })).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate for HTTP or semantic read failures", async () => {
    const revalidate = vi.fn();
    const httpFailure = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const semanticFailure = vi.fn().mockResolvedValue(new Response(JSON.stringify({ marked: false }), { status: 200 }));

    await expect(markUnreadMessages({ messageIds: ["message-1"], fetchImpl: httpFailure, revalidate })).resolves.toBe(false);
    await expect(markUnreadMessages({ messageIds: ["message-1"], fetchImpl: semanticFailure, revalidate })).resolves.toBe(false);

    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refreshes once for durable progress before a later read failure", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ marked: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ marked: false }), { status: 200 }));
    const revalidate = vi.fn();

    await expect(markUnreadMessages({
      messageIds: ["message-1", "message-2"],
      fetchImpl,
      revalidate,
    })).resolves.toBe(false);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("returns compose validation failures without truncating the body", async () => {
    composeMerchantMessage.mockRejectedValue(new Error("Body must contain at most 500 graphemes."));
    const form = new FormData();
    form.set("intent", "compose");
    form.set("body", "👩‍💻".repeat(501));

    const response = await action({
      request: new Request("https://example.test/app/merchant-support", { method: "POST", body: form }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Body must contain at most 500 graphemes." });
    expect(composeMerchantMessage).toHaveBeenCalledWith(expect.objectContaining({ body: "👩‍💻".repeat(501) }));
  });
});