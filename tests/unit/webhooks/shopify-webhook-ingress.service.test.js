import { readFileSync } from "node:fs";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

class TestPublicationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ShopifyWebhookPublicationError";
    this.code = code;
  }
}

const store = {
  shopsByDomain: new Map(),
};

const dbMock = {
  shop: {
    findUnique: vi.fn(async ({ where }) => store.shopsByDomain.get(where.domain) ?? null),
  },
};

const publicationMock = {
  ShopifyWebhookPublicationError: TestPublicationError,
  publishShopifyCheckoutCreatedEvent: vi.fn(async () => ({
    queue: "checkout-events",
    jobId: "checkout-created-job",
    outcome: "enqueued",
  })),
  publishShopifyCheckoutUpdatedEvent: vi.fn(async () => ({
    queue: "checkout-events",
    jobId: "checkout-updated-job",
    outcome: "enqueued",
  })),
  publishShopifyCartActivityEvent: vi.fn(async () => ({
    queue: "checkout-events",
    jobId: "cart-activity-job",
    outcome: "enqueued",
  })),
  publishShopifyOrderCompletedEvent: vi.fn(async () => ({
    queue: "order-events",
    jobId: "order-job",
    outcome: "enqueued",
  })),
};

vi.mock("../../../app/db.server", () => ({ default: dbMock }));

vi.mock("../../../app/services/webhooks/shopify-webhook-queue.server", () => publicationMock);

const { ingestShopifyWebhook } = await import(
  "../../../app/services/webhooks/shopify-webhook-ingress.service"
);

function resetState() {
  store.shopsByDomain.clear();
  dbMock.shop.findUnique.mockClear();
  publicationMock.publishShopifyCheckoutCreatedEvent.mockClear();
  publicationMock.publishShopifyCheckoutUpdatedEvent.mockClear();
  publicationMock.publishShopifyCartActivityEvent.mockClear();
  publicationMock.publishShopifyOrderCompletedEvent.mockClear();
  delete process.env.REDIS_URL;
}

function activeShop() {
  return {
    id: "shop_1",
    domain: "shop.myshopify.com",
    status: "ACTIVE",
  };
}

function baseRequest(headers = {}) {
  return new Request("https://app.example/webhooks", {
    method: "POST",
    headers: {
      "X-Shopify-Webhook-Id": "delivery-1",
      ...headers,
    },
  });
}

function checkoutInput(overrides = {}) {
  return {
    request: baseRequest(),
    appKey: "app-key",
    shop: "shop.myshopify.com",
    topic: "CHECKOUTS_CREATE",
    payload: {
      token: "checkout-token-1",
      cart_token: "cart-token-1",
      created_at: "2024-01-01T00:00:00Z",
      abandoned_checkout_url: "https://shop.example/checkout",
    },
    apiVersion: "2026-07",
    eventId: "event-1",
    triggeredAt: "2024-01-01T00:00:00Z",
    name: "checkout/create",
    ...overrides,
  };
}

function orderInput(overrides = {}) {
  return {
    request: baseRequest(),
    appKey: "app-key",
    shop: "shop.myshopify.com",
    topic: "ORDERS_CREATE",
    payload: {
      admin_graphql_api_id: "gid://shopify/Order/123",
      token: "ignored-checkout-token",
      order_status_url: "https://example.invalid/orders/123/authenticate?key=ignored",
      checkout_token: null,
      cart_token: null,
      customer: { admin_graphql_api_id: "gid://shopify/Customer/42" },
      current_total_price: "19.99",
      currency: "USD",
      created_at: "2024-01-02T00:00:00Z",
    },
    apiVersion: "2026-07",
    eventId: "event-1",
    triggeredAt: "2024-01-02T00:00:00Z",
    name: "orders/create",
    ...overrides,
  };
}

beforeEach(() => {
  resetState();
});

describe("shopify webhook ingress", () => {
  it("does not contain the legacy receipt, outbox, GraphQL, or unified-queue paths", () => {
    const source = readFileSync(
      new URL(
        "../../../app/services/webhooks/shopify-webhook-ingress.service.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain("ShopifyWebhookReceipt");
    expect(source).not.toContain("ShopifyWebhookOutbox");
    expect(source).not.toContain("WEBHOOK_DISPATCH_MODE");
    expect(source).not.toContain("queue.add");
    expect(source).not.toContain("GraphQL");
    expect(source).not.toContain("SHOPIFY_COMMERCE_EVENTS");
  });

  it("publishes checkout-created events immediately with normalized payload", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(checkoutInput());

    expect(response.status).toBe(200);
    expect(publicationMock.publishShopifyCheckoutCreatedEvent).toHaveBeenCalledTimes(1);
    expect(publicationMock.publishShopifyCheckoutCreatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          schemaVersion: 2,
          eventType: "checkout.created",
          orderingKey: "shop_1:checkout-token-1",
          payload: {
            checkoutToken: "checkout-token-1",
            cartToken: "cart-token-1",
            abandonedCheckoutUrl: "https://shop.example/checkout",
            checkoutCreatedAt: "2024-01-01T00:00:00.000Z",
          },
        }),
      }),
    );
  });

  it("publishes checkout-created with a provider offset timestamp normalised to UTC ISO", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    // Real Shopify fixture value: -05:00 offset, not a UTC `Z` datetime.
    const response = await ingestShopifyWebhook(
      checkoutInput({
        payload: {
          token: "checkout-token-1",
          cart_token: "cart-token-1",
          created_at: "2021-12-31T19:00:00-05:00",
          abandoned_checkout_url: "https://shop.example/checkout",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(publicationMock.publishShopifyCheckoutCreatedEvent).toHaveBeenCalledTimes(1);
    expect(publicationMock.publishShopifyCheckoutCreatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          schemaVersion: 2,
          eventType: "checkout.created",
          payload: {
            checkoutToken: "checkout-token-1",
            cartToken: "cart-token-1",
            abandonedCheckoutUrl: "https://shop.example/checkout",
            checkoutCreatedAt: "2022-01-01T00:00:00.000Z",
          },
        }),
      }),
    );
  });

  it("emits independent buyer context on checkout-created events", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await ingestShopifyWebhook(
      checkoutInput({
        payload: {
          token: "checkout-token-1",
          customer_locale: "fr-CA",
          billing_address: { country_code: "CA" },
          shipping_address: { country_code: "US" },
          presentment_currency: "USD",
          currency: "CAD",
        },
      }),
    );

    expect(publicationMock.publishShopifyCheckoutCreatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          internationalContext: {
            languageTag: "fr-CA",
            languageSource: "shopify",
            countryCode: "CA",
            currencyCode: "USD",
            timeZone: null,
          },
        }),
      }),
    );
  });

  it("publishes checkout update events without basket payload", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      checkoutInput({
        topic: "CHECKOUTS_UPDATE",
        payload: {
          token: "checkout-token-1",
          cart_token: "ignored",
          line_items: [{ title: "ignored" }],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(publicationMock.publishShopifyCheckoutUpdatedEvent).toHaveBeenCalledTimes(1);
    expect(publicationMock.publishShopifyCheckoutUpdatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          schemaVersion: 2,
          eventType: "checkout.updated",
          orderingKey: "shop_1:checkout-token-1",
          payload: {
            checkoutToken: "checkout-token-1",
          },
        }),
      }),
    );
  });

  it("emits updated buyer context without changing checkout ordering", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await ingestShopifyWebhook(
      checkoutInput({
        topic: "CHECKOUTS_UPDATE",
        payload: {
          token: "checkout-token-1",
          customer_locale: "en-GB",
          billing_address: { country_code: "GB" },
          shipping_address: { country_code: "FR" },
          presentment_currency: "GBP",
        },
      }),
    );

    expect(publicationMock.publishShopifyCheckoutUpdatedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          orderingKey: "shop_1:checkout-token-1",
          internationalContext: {
            languageTag: "en-GB",
            languageSource: "shopify",
            countryCode: "GB",
            currencyCode: "GBP",
            timeZone: null,
          },
        }),
      }),
    );
  });

  it("publishes order events immediately and preserves nullable checkout_token", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      orderInput({
        payload: {
          admin_graphql_api_id: "gid://shopify/Order/456",
          token: "ignored-token",
          order_status_url: "https://example.invalid/orders/456/authenticate?key=ignored",
          checkout_token: null,
          cart_token: null,
          customer: { admin_graphql_api_id: "gid://shopify/Customer/43" },
          current_total_price: "29.99",
          currency: "USD",
          created_at: "2024-01-03T00:00:00Z",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(publicationMock.publishShopifyOrderCompletedEvent).toHaveBeenCalledTimes(1);
    expect(publicationMock.publishShopifyOrderCompletedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: "order.completed",
          orderingKey: "shop_1:gid://shopify/Order/456",
          payload: expect.objectContaining({
            orderId: "gid://shopify/Order/456",
            checkoutToken: null,
            cartToken: null,
          }),
        }),
      }),
    );
  });

  it("emits billing buyer context on orders without using shipping geography", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await ingestShopifyWebhook(
      orderInput({
        payload: {
          admin_graphql_api_id: "gid://shopify/Order/789",
          checkout_token: "checkout-token-1",
          cart_token: null,
          customer_locale: null,
          billing_address: { country_code: "DE" },
          shipping_address: { country_code: "FR" },
          presentment_currency: "EUR",
          currency: "USD",
          created_at: "2024-01-03T00:00:00Z",
        },
      }),
    );

    expect(publicationMock.publishShopifyOrderCompletedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          internationalContext: {
            languageTag: null,
            languageSource: null,
            countryCode: "DE",
            currencyCode: "EUR",
            timeZone: null,
          },
        }),
      }),
    );
  });

  it("rejects checkout payloads without a checkout token", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      checkoutInput({
        payload: {
          token: null,
          created_at: "2024-01-01T00:00:00Z",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(publicationMock.publishShopifyCheckoutCreatedEvent).not.toHaveBeenCalled();
    expect(publicationMock.publishShopifyCheckoutUpdatedEvent).not.toHaveBeenCalled();
    expect(publicationMock.publishShopifyOrderCompletedEvent).not.toHaveBeenCalled();
  });

  it("returns 503 when publication fails", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());
    publicationMock.publishShopifyCheckoutCreatedEvent.mockRejectedValueOnce(
      new TestPublicationError("Redis down", "REDIS_UNAVAILABLE"),
    );

    const response = await ingestShopifyWebhook(checkoutInput());

    expect(response.status).toBe(503);
  });

  it.each([
    ["CARTS_CREATE", []],
    ["CARTS_UPDATE", [{ id: "line-1" }]],
  ])("publishes %s as cart activity", async (topic, lineItems) => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      checkoutInput({
        topic,
        payload: { token: "cart-token-1", line_items: lineItems },
      }),
    );

    expect(response.status).toBe(200);
    expect(publicationMock.publishShopifyCartActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: "cart.activity",
          orderingKey: "cart:6:shop_1:12:cart-token-1",
          tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
          payload: { cartToken: "cart-token-1", isEmpty: lineItems.length === 0 },
        }),
      }),
    );
  });

  it("does not add international context to cart events", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await ingestShopifyWebhook(
      checkoutInput({
        topic: "CARTS_UPDATE",
        payload: {
          token: "cart-token-1",
          line_items: [],
          customer_locale: "fr-CA",
          billing_address: { country_code: "CA" },
          presentment_currency: "CAD",
        },
      }),
    );

    expect(
      publicationMock.publishShopifyCartActivityEvent.mock.calls[0][0].event,
    ).not.toHaveProperty("internationalContext");
  });

  it("publishes cart activity with unknown emptiness when line items are unavailable", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      checkoutInput({ topic: "carts/update", payload: { token: "cart-token-1" } }),
    );

    expect(response.status).toBe(200);
    expect(publicationMock.publishShopifyCartActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          payload: { cartToken: "cart-token-1", isEmpty: null },
        }),
      }),
    );
  });

  it("rejects cart payloads without a valid cart token", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      checkoutInput({ topic: "CARTS_CREATE", payload: { line_items: [] } }),
    );

    expect(response.status).toBe(400);
    expect(publicationMock.publishShopifyCartActivityEvent).not.toHaveBeenCalled();
  });

  it("logs a structured PII-safe record through the shared logging boundary", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await ingestShopifyWebhook(
      checkoutInput({
        payload: {
          token: "checkout-token-1",
          created_at: "2024-01-01T00:00:00Z",
          customer: {
            email: "customer@example.com",
            phone: "+15555550100",
          },
        },
      }),
    );

    // The shared logger's default sink emits one JSON LogRecord per call.
    const records = infoSpy.mock.calls
      .flat()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const record = records.find((r) => r.event === "shopify.webhook.outcome");
    expect(record).toBeDefined();
    expect(record.level).toBe("info");

    // Canonical telemetry identity is supplied by moda-interact.
    expect(record["service.namespace"]).toBe("moda-interact");
    expect(record["service.name"]).toBe("moda-interact");
    expect(record["deployment.environment.name"]).toBe("test");

    // Only the PII-safe observation fields are logged.
    expect(record.data).toMatchObject({
      topic: "CHECKOUTS_CREATE",
      deliveryId: "delivery-1",
      queue: "checkout-events",
      jobId: "checkout-created-job",
      outcome: "ENQUEUED",
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
    });
    expect(typeof record.data.ackMs).toBe("number");

    // Sensitive payload/PII never reaches the log output.
    const raw = JSON.stringify(records);
    expect(raw).not.toContain("customer@example.com");
    expect(raw).not.toContain("+15555550100");
    expect(raw).not.toContain("checkout-token-1");

    infoSpy.mockRestore();
  });
});