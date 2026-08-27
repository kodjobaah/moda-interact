import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateWebhookMock = vi.fn();
vi.mock("../../../app/shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
  apiKey: "app-key",
}));

const ingestShopifyWebhookMock = vi
  .fn()
  .mockResolvedValue(new Response(null, { status: 200 }));
vi.mock("../../../app/services/webhooks/webhook-ingress.service", () => ({
  ingestShopifyWebhook: ingestShopifyWebhookMock,
}));

const { action } = await import("../../../app/routes/webhooks.jsx");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("webhooks route action", () => {
  it("preserves an authentication failure instead of swallowing it", async () => {
    const authError = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValue(authError);

    const request = new Request("https://app.example/webhooks", {
      method: "POST",
    });

    await expect(action({ request })).rejects.toBe(authError);
    expect(ingestShopifyWebhookMock).not.toHaveBeenCalled();
  });

  it("delegates authenticated requests to the ingress service", async () => {
    authenticateWebhookMock.mockResolvedValue({
      topic: "ORDERS_CREATE",
      shop: "shop.myshopify.com",
      payload: { admin_graphql_api_id: "gid://shopify/Order/1" },
      apiVersion: "2026-07",
      eventId: "event-1",
      triggeredAt: "2024-01-01T00:00:00Z",
      name: "orders/create",
    });

    const request = new Request("https://app.example/webhooks", {
      method: "POST",
      headers: { "X-Shopify-Webhook-Id": "delivery-1" },
    });

    const response = await action({ request });

    expect(response.status).toBe(200);
    expect(ingestShopifyWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appKey: "app-key",
        shop: "shop.myshopify.com",
        topic: "ORDERS_CREATE",
      }),
    );
  });
});
