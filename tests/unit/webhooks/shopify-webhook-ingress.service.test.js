import { readFileSync } from "node:fs";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseShopifyCommerceEvent } from "@modainteract/moda-interact-shared/shopify";

const store = {
  shopsByDomain: new Map(),
  receiptsByComposite: new Map(),
  receiptsById: new Map(),
  outboxesByReceiptId: new Map(),
};

const dbMock = {
  $transaction: vi.fn(async (callback) => callback(dbMock)),
  shop: {
    findUnique: vi.fn(async ({ where }) => store.shopsByDomain.get(where.domain) ?? null),
  },
  shopifyWebhookReceipt: {
    create: vi.fn(async ({ data, include }) => {
      const compositeKey = `${data.appKey}:${data.deliveryId}`;
      if (store.receiptsByComposite.has(compositeKey)) {
        throw {
          code: "P2002",
          meta: { target: ["appKey", "deliveryId"] },
        };
      }

      const outbox = data.outbox?.create
        ? {
            id: `outbox_${store.outboxesByReceiptId.size + 1}`,
            receiptId: data.id,
            ...data.outbox.create,
          }
        : null;

      const receipt = {
        ...data,
        ...(include?.outbox ? { outbox } : {}),
      };

      store.receiptsByComposite.set(compositeKey, receipt);
      store.receiptsById.set(data.id, receipt);

      if (outbox) {
        store.outboxesByReceiptId.set(data.id, outbox);
      }

      return receipt;
    }),
    findUnique: vi.fn(async ({ where }) => {
      if (where.appKey_deliveryId) {
        const key = `${where.appKey_deliveryId.appKey}:${where.appKey_deliveryId.deliveryId}`;
        return store.receiptsByComposite.get(key) ?? null;
      }

      if (where.id) {
        return store.receiptsById.get(where.id) ?? null;
      }

      return null;
    }),
  },
};

vi.mock("../../../app/db.server", () => ({ default: dbMock }));

const { ingestShopifyWebhook } = await import(
  "../../../app/services/webhooks/shopify-webhook-ingress.service"
);

function resetStore() {
  store.shopsByDomain.clear();
  store.receiptsByComposite.clear();
  store.receiptsById.clear();
  store.outboxesByReceiptId.clear();
  vi.clearAllMocks();
  delete process.env.REDIS_URL;
}

function activeShop() {
  return {
    id: "shop_1",
    domain: "shop.myshopify.com",
    status: "ACTIVE",
    settings: {
      recoveryDelayMinutes: 45,
    },
  };
}

function inactiveShop() {
  return {
    id: "shop_2",
    domain: "inactive.myshopify.com",
    status: "UNINSTALLED",
    settings: null,
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
      updated_at: "2024-01-01T00:10:00Z",
      completed_at: "2024-01-01T00:20:00Z",
      currency: "USD",
      total_price: "19.99",
      abandoned_checkout_url: "https://shop.example/checkout",
      customer: {
        id: 42,
        email: "customer@example.com",
        phone: "+15555550100",
        first_name: "Ada",
        last_name: "Lovelace",
      },
      line_items: [
        {
          id: "li_1",
          product_id: 1,
          variant_id: 2,
          title: "T-Shirt",
          sku: "TS-1",
          quantity: 1,
          price: "19.99",
        },
      ],
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
      checkout_token: "checkout-token-1",
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

function lastReceiptCreateData() {
  const calls = dbMock.shopifyWebhookReceipt.create.mock.calls;
  return calls[calls.length - 1]?.[0].data;
}

beforeEach(() => {
  resetStore();
});

describe("shopify webhook ingress", () => {
  it("does not contain the legacy Redis or unified destination code path", () => {
    const source = readFileSync(
      new URL(
        "../../../app/services/webhooks/shopify-webhook-ingress.service.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain("WEBHOOK_DISPATCH_MODE");
    expect(source).not.toContain("queue.add");
    expect(source).not.toContain("bullmq");
    expect(source).not.toContain("ioredis");
    expect(source).not.toContain("SHOPIFY_COMMERCE_EVENTS");
  });

  it("writes checkout.observed to CHECKOUT_EVENTS with the merchant delay", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(checkoutInput());

    expect(response.status).toBe(200);

    const data = lastReceiptCreateData();
    const outbox = data.outbox.create;

    expect(data.disposition).toBe("ACCEPTED");
    expect(data.topic).toBe("CHECKOUTS_CREATE");
    expect(outbox.destination).toBe("CHECKOUT_EVENTS");
    expect(outbox.jobName).toBe("checkout-created");
    expect(outbox.delayMs).toBe(45 * 60 * 1000);
    expect(outbox.orderingKey).toBe("shop_1:checkout-token-1");
    expect(parseShopifyCommerceEvent(outbox.payload)).toMatchObject({
      eventType: "checkout.observed",
      orderingKey: "shop_1:checkout-token-1",
      payload: {
        checkoutToken: "checkout-token-1",
        completedAt: "2024-01-01T00:20:00Z",
      },
    });
    expect(outbox.payload.eventType).not.toBe("order.completed");
    expect(outbox.payload).not.toHaveProperty("delayMs");
  });

  it("writes order.completed to ORDER_EVENTS and accepts missing checkout tokens", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const withToken = await ingestShopifyWebhook(orderInput());

    expect(withToken.status).toBe(200);

    let data = lastReceiptCreateData();
    let outbox = data.outbox.create;

    expect(data.disposition).toBe("ACCEPTED");
    expect(outbox.destination).toBe("ORDER_EVENTS");
    expect(outbox.jobName).toBe("order-completed");
    expect(outbox.delayMs).toBe(0);
    expect(outbox.orderingKey).toBe("shop_1:checkout-token-1");
    expect(parseShopifyCommerceEvent(outbox.payload)).toMatchObject({
      eventType: "order.completed",
      payload: {
        orderId: "gid://shopify/Order/123",
        checkoutToken: "checkout-token-1",
      },
    });

    const withoutToken = await ingestShopifyWebhook(
      orderInput({
        payload: {
          admin_graphql_api_id: "gid://shopify/Order/456",
          checkout_token: null,
          customer: { admin_graphql_api_id: "gid://shopify/Customer/43" },
          current_total_price: "29.99",
          currency: "USD",
          created_at: "2024-01-03T00:00:00Z",
        },
      }),
    );

    expect(withoutToken.status).toBe(200);

    data = lastReceiptCreateData();
    outbox = data.outbox.create;

    expect(outbox.destination).toBe("ORDER_EVENTS");
    expect(outbox.orderingKey).toBe("shop_1:gid://shopify/Order/456");
    expect(parseShopifyCommerceEvent(outbox.payload)).toMatchObject({
      eventType: "order.completed",
      payload: {
        orderId: "gid://shopify/Order/456",
        checkoutToken: null,
      },
    });
  });

  it("keeps completedAt on checkout events and still accepts them", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await ingestShopifyWebhook(
      checkoutInput({
        payload: {
          ...checkoutInput().payload,
          completed_at: "2024-01-01T00:20:00Z",
        },
      }),
    );

    const outbox = lastReceiptCreateData().outbox.create;
    const parsed = parseShopifyCommerceEvent(outbox.payload);

    expect(parsed.eventType).toBe("checkout.observed");
    expect(parsed.payload.completedAt).toBe("2024-01-01T00:20:00Z");
  });

  it("persists IGNORED receipts for cart topics and creates no outbox", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      checkoutInput({
        topic: "CARTS_CREATE",
        payload: { cart_id: "cart-1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(lastReceiptCreateData().disposition).toBe("IGNORED");
    expect(lastReceiptCreateData().outbox).toBeUndefined();
    expect(store.outboxesByReceiptId.size).toBe(0);
  });

  it("persists REJECTED receipts for malformed supported payloads", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      checkoutInput({
        payload: {
          token: null,
          created_at: "2024-01-01T00:00:00Z",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(lastReceiptCreateData().disposition).toBe("REJECTED");
    expect(lastReceiptCreateData().outbox).toBeUndefined();

    const orderResponse = await ingestShopifyWebhook(
      orderInput({
        payload: {
          checkout_token: "checkout-token-1",
          created_at: null,
        },
      }),
    );

    expect(orderResponse.status).toBe(200);
    expect(lastReceiptCreateData().disposition).toBe("REJECTED");
    expect(lastReceiptCreateData().outbox).toBeUndefined();
  });

  it("persists QUARANTINED receipts for unknown or inactive tenants", async () => {
    store.shopsByDomain.set("inactive.myshopify.com", inactiveShop());

    const unknownTenantResponse = await ingestShopifyWebhook(
      checkoutInput({
        shop: "missing.myshopify.com",
      }),
    );

    expect(unknownTenantResponse.status).toBe(200);
    expect(lastReceiptCreateData().disposition).toBe("QUARANTINED");
    expect(lastReceiptCreateData().shopId).toBeNull();
    expect(lastReceiptCreateData().outbox).toBeUndefined();

    resetStore();
    store.shopsByDomain.set("inactive.myshopify.com", inactiveShop());

    const inactiveTenantResponse = await ingestShopifyWebhook(
      checkoutInput({
        shop: "inactive.myshopify.com",
      }),
    );

    expect(inactiveTenantResponse.status).toBe(200);
    expect(lastReceiptCreateData().disposition).toBe("QUARANTINED");
    expect(lastReceiptCreateData().shopId).toBeNull();
    expect(lastReceiptCreateData().outbox).toBeUndefined();
  });

  it("returns 400 and creates no receipt when delivery ids are missing or conflicting", async () => {
    const missingDeliveryResponse = await ingestShopifyWebhook(
      checkoutInput({
        request: new Request("https://app.example/webhooks", {
          method: "POST",
        }),
      }),
    );

    expect(missingDeliveryResponse.status).toBe(400);
    expect(dbMock.shopifyWebhookReceipt.create).not.toHaveBeenCalled();

    const conflictingDeliveryResponse = await ingestShopifyWebhook(
      checkoutInput({
        request: baseRequest({
          "X-Shopify-Webhook-Id": "delivery-a",
          "Webhook-Id": "delivery-b",
        }),
      }),
    );

    expect(conflictingDeliveryResponse.status).toBe(400);
    expect(dbMock.shopifyWebhookReceipt.create).not.toHaveBeenCalled();
  });

  it("creates one durable receipt and one outbox for sequential duplicate deliveries", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const input = checkoutInput();
    const first = await ingestShopifyWebhook(input);
    const second = await ingestShopifyWebhook(input);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.receiptsByComposite.size).toBe(1);
    expect(store.outboxesByReceiptId.size).toBe(1);
  });

  it("creates one durable receipt and one outbox for concurrent duplicate deliveries", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const input = checkoutInput();
    const [first, second] = await Promise.all([
      ingestShopifyWebhook(input),
      ingestShopifyWebhook(input),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.receiptsByComposite.size).toBe(1);
    expect(store.outboxesByReceiptId.size).toBe(1);
  });

  it("keeps receipts separate when the eventId is shared across deliveries", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const first = await ingestShopifyWebhook(
      checkoutInput({
        request: baseRequest({ "X-Shopify-Webhook-Id": "delivery-1" }),
        eventId: "shared-event",
      }),
    );

    const second = await ingestShopifyWebhook(
      checkoutInput({
        request: baseRequest({ "X-Shopify-Webhook-Id": "delivery-2" }),
        eventId: "shared-event",
      }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.receiptsById.size).toBe(2);
  });

  it("returns non-2xx when the transaction fails", async () => {
    dbMock.$transaction.mockRejectedValueOnce(new Error("database down"));
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await expect(ingestShopifyWebhook(checkoutInput())).rejects.toThrow(
      "database down",
    );
    expect(store.receiptsByComposite.size).toBe(0);
    expect(store.outboxesByReceiptId.size).toBe(0);
  });

  it("logs structured PII-safe output", async () => {
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

    const logLine = infoSpy.mock.calls
      .map((call) => call.map(String).join(" "))
      .join("\n");

    expect(logLine).toContain("shopify_webhook");
    expect(logLine).toContain("receiptId");
    expect(logLine).toContain("deliveryId");
    expect(logLine).toContain("providerTopic");
    expect(logLine).toContain("eventType");
    expect(logLine).toContain("destination");
    expect(logLine).toContain("ackMs");
    expect(logLine).not.toContain("customer@example.com");
    expect(logLine).not.toContain("+15555550100");

    infoSpy.mockRestore();
  });
});