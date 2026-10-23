import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateWebhookMock = vi.fn();
vi.mock("../../../app/shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
  apiKey: "app-key",
}));

const ingestShopifyWebhookMock = vi
  .fn()
  .mockResolvedValue(new Response(null, { status: 200 }));
vi.mock("../../../app/services/webhooks/shopify-webhook-ingress.service", () => ({
  ingestShopifyWebhook: ingestShopifyWebhookMock,
  isShopifyWhatsAppConsentTopic: (topic) => topic?.trim().toLowerCase().replaceAll("/", "_") === "customers_whats_app_marketing_consent_update",
}));

const observabilityMocks = vi.hoisted(() => ({
  received: vi.fn(),
  authenticationFailure: vi.fn(),
  routeFailure: vi.fn(),
}));
vi.mock("../../../app/services/webhooks/shopify-webhook-observability.server", () => ({
  recordShopifyWebhookReceived: observabilityMocks.received,
  recordShopifyWebhookAuthenticationFailure: observabilityMocks.authenticationFailure,
  recordShopifyWebhookRouteFailure: observabilityMocks.routeFailure,
}));

const { action } = await import("../../../app/routes/webhooks/root/route.jsx");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("webhooks route action", () => {
  it("preserves exact authenticated numeric customer token and still requires HMAC", async () => {
    const raw = '{"customer_id":706405506930370084,"phone_number":"+447700900123"}';
    authenticateWebhookMock.mockImplementationOnce(async (request) => {
      expect(JSON.parse(await request.text()).customer_id).toBe(706405506930370000);
      return {
        topic: "CUSTOMERS_WHATS_APP_MARKETING_CONSENT_UPDATE",
        shop: "shop.myshopify.com", payload: JSON.parse(raw),
        apiVersion: "2026-07", eventId: "e1", triggeredAt: "2026-10-22T09:00:00Z",
      };
    });
    const request = new Request("https://app.example/webhooks", {
      method: "POST", headers: { "X-Shopify-Topic": "customers_whats_app_marketing_consent/update", "X-Shopify-Webhook-Id": "d1" }, body: raw,
    });
    expect((await action({ request })).status).toBe(200);
    expect(ingestShopifyWebhookMock).toHaveBeenCalledWith(expect.objectContaining({
      authenticatedConsentRawBody: raw,
    }));
  });

  it("does not read or enqueue an invalid-HMAC consent webhook", async () => {
    const authFailure = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(authFailure);
    const request = new Request("https://app.example/webhooks", {
      method: "POST", headers: { "X-Shopify-Topic": "customers_whats_app_marketing_consent/update" }, body: '{"customer_id":42}',
    });
    await expect(action({ request })).rejects.toBe(authFailure);
    expect(ingestShopifyWebhookMock).not.toHaveBeenCalled();
  });

  it("preserves an authentication failure instead of swallowing it", async () => {
    const authError = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValue(authError);

    const request = new Request("https://app.example/webhooks", {
      method: "POST",
    });

    await expect(action({ request })).rejects.toBe(authError);
    expect(observabilityMocks.received).toHaveBeenCalledWith({
      request,
      route: "/webhooks",
    });
    expect(observabilityMocks.authenticationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ request, route: "/webhooks", error: authError }),
    );
    expect(ingestShopifyWebhookMock).not.toHaveBeenCalled();
  });

  it("delegates authenticated requests to the ingress service", async () => {
    authenticateWebhookMock.mockResolvedValue({
      topic: "CHECKOUTS_CREATE",
      shop: "shop.myshopify.com",
      payload: { token: "checkout-token-1" },
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
    expect(observabilityMocks.received).toHaveBeenCalledWith({
      request,
      route: "/webhooks",
    });
    expect(observabilityMocks.authenticationFailure).not.toHaveBeenCalled();
    expect(ingestShopifyWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appKey: "app-key",
        shop: "shop.myshopify.com",
        topic: "CHECKOUTS_CREATE",
        payload: { token: "checkout-token-1" },
      }),
    );
  });

  it("logs an authenticated route failure and preserves the original error", async () => {
    authenticateWebhookMock.mockResolvedValue({
      topic: "CHECKOUTS_CREATE",
      shop: "shop.myshopify.com",
      payload: { token: "checkout-token-1" },
      apiVersion: "2026-07",
      eventId: "event-1",
      triggeredAt: "2024-01-01T00:00:00Z",
      name: "orders/create",
    });
    const ingressError = new Error("database unavailable");
    ingestShopifyWebhookMock.mockRejectedValueOnce(ingressError);

    const request = new Request("https://app.example/webhooks", {
      method: "POST",
    });

    await expect(action({ request })).rejects.toBe(ingressError);
    expect(observabilityMocks.routeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        route: "/webhooks",
        topic: "CHECKOUTS_CREATE",
        eventId: "event-1",
        shopDomain: "shop.myshopify.com",
        error: ingressError,
      }),
    );
  });
});
