import { readFileSync } from "node:fs";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

class ExplodingRedis {
  constructor() {
    throw new Error("Redis should not be constructed");
  }
}

vi.mock("ioredis", () => ({ default: ExplodingRedis }));
vi.mock("bullmq", () => {
  throw new Error("BullMQ should not be imported by webhook ingress");
});

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
    create: vi.fn(async ({ data }) => {
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
        outbox,
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
    delete: vi.fn(async ({ where }) => {
      const receipt = store.receiptsById.get(where.id) ?? null;
      if (!receipt) {
        return null;
      }

      store.receiptsById.delete(where.id);
      store.receiptsByComposite.delete(`${receipt.appKey}:${receipt.deliveryId}`);
      store.outboxesByReceiptId.delete(where.id);
      return receipt;
    }),
    count: vi.fn(async ({ where }) => {
      if (where.receiptId) {
        return store.outboxesByReceiptId.has(where.receiptId) ? 1 : 0;
      }

      return store.receiptsById.size;
    }),
  },
  shopifyWebhookOutbox: {
    findUnique: vi.fn(async ({ where }) => {
      if (where.id) {
        return store.outboxesByReceiptId.get(
          [...store.outboxesByReceiptId.entries()].find(([, outbox]) => outbox.id === where.id)?.[0] ?? "",
        ) ?? null;
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
  delete process.env.WEBHOOK_DISPATCH_MODE;
  delete process.env.REDIS_URL;
}

function activeShop() {
  return {
    id: "shop_1",
    domain: "shop.myshopify.com",
    status: "ACTIVE",
  };
}

function inactiveShop() {
  return {
    id: "shop_2",
    domain: "inactive.myshopify.com",
    status: "UNINSTALLED",
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

function baseInput(overrides = {}) {
  return {
    request: baseRequest(),
    appKey: "app-key",
    shop: "shop.myshopify.com",
    topic: "CHECKOUTS_CREATE",
    payload: {
      token: "checkout-token-1",
      cart_token: "cart-token-1",
      customer: { email: "customer@example.com" },
      line_items: [],
    },
    apiVersion: "2026-07",
    eventId: "event-1",
    triggeredAt: "2024-01-01T00:00:00Z",
    name: "checkout/create",
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
  it("does not contain the legacy dispatch switch or request-path Redis/BullMQ code", () => {
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
    expect(source).not.toContain("delayMs");
    expect(source).not.toContain("checkout-created");
    expect(source).not.toContain("order-completed");
  });

  it("works without Redis configuration", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(baseInput());

    expect(response.status).toBe(200);
    expect(dbMock.shopifyWebhookReceipt.create).toHaveBeenCalledTimes(1);
  });

  it("creates a V1 checkout envelope and commits one receipt and one outbox", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(baseInput({
      topic: "CHECKOUTS_CREATE",
      payload: {
        token: "checkout-token-1",
        cart_token: "cart-token-1",
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
            product_id: 1,
            variant_id: 2,
            title: "T-Shirt",
            sku: "TS-1",
            quantity: 1,
            price: "19.99",
          },
        ],
      },
    }));

    expect(response.status).toBe(200);
    expect(store.receiptsByComposite.size).toBe(1);
    expect(store.outboxesByReceiptId.size).toBe(1);

    const data = lastReceiptCreateData();
    const outbox = data.outbox.create;

    expect(data.disposition).toBe("ACCEPTED");
    expect(data.internalEventType).toBe("checkout.observed");
    expect(outbox.destination).toBe("SHOPIFY_COMMERCE_EVENTS");
    expect(outbox.contractVersion).toBe(1);
    expect(outbox.state).toBe("PENDING");
    expect(outbox.jobId).toMatch(/^shopify-[0-9a-f]{64}$/);
    expect(outbox.orderingKey).toBe("shop_1:checkout-token-1");
    expect(outbox.envelope).toMatchObject({
      schemaVersion: 1,
      receiptId: data.id,
      deliveryId: "delivery-1",
      eventType: "checkout.observed",
      providerTopic: "CHECKOUTS_CREATE",
      tenant: {
        shopId: "shop_1",
        shopDomain: "shop.myshopify.com",
      },
      orderingKey: "shop_1:checkout-token-1",
      payload: {
        checkoutToken: "checkout-token-1",
        cartToken: "cart-token-1",
        currency: "USD",
      },
    });
    expect(outbox.envelope).not.toHaveProperty("delayMs");
  });

  it("creates a V1 order envelope and uses the same target contract", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      baseInput({
        topic: "ORDERS_CREATE",
        payload: {
          admin_graphql_api_id: "gid://shopify/Order/123",
          checkout_token: "checkout-token-1",
          customer: { admin_graphql_api_id: "gid://shopify/Customer/42" },
          current_total_price: "19.99",
          currency: "USD",
        },
      }),
    );

    expect(response.status).toBe(200);

    const data = lastReceiptCreateData();
    const outbox = data.outbox.create;

    expect(data.disposition).toBe("ACCEPTED");
    expect(data.internalEventType).toBe("order.completed");
    expect(outbox.destination).toBe("SHOPIFY_COMMERCE_EVENTS");
    expect(outbox.contractVersion).toBe(1);
    expect(outbox.orderingKey).toBe("shop_1:checkout-token-1");
    expect(outbox.envelope).toMatchObject({
      schemaVersion: 1,
      eventType: "order.completed",
      providerTopic: "ORDERS_CREATE",
      tenant: {
        shopId: "shop_1",
        shopDomain: "shop.myshopify.com",
      },
      orderingKey: "shop_1:checkout-token-1",
      payload: {
        checkoutToken: "checkout-token-1",
        orderId: "gid://shopify/Order/123",
      },
    });
  });

  it("uses the same ordering key contract for checkout and order events", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await ingestShopifyWebhook(baseInput());
    const checkoutOutbox = lastReceiptCreateData().outbox.create;

    resetStore();
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await ingestShopifyWebhook(
      baseInput({
        topic: "ORDERS_CREATE",
        payload: {
          checkout_token: "checkout-token-1",
          current_total_price: "19.99",
          currency: "USD",
        },
      }),
    );
    const orderOutbox = lastReceiptCreateData().outbox.create;

    expect(checkoutOutbox.orderingKey).toBe("shop_1:checkout-token-1");
    expect(orderOutbox.orderingKey).toBe("shop_1:checkout-token-1");
    expect(checkoutOutbox.destination).toBe(orderOutbox.destination);
    expect(checkoutOutbox.contractVersion).toBe(orderOutbox.contractVersion);
  });

  it("creates one durable receipt and one outbox for duplicate deliveries", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const input = baseInput();
    const [first, second] = await Promise.all([
      ingestShopifyWebhook(input),
      ingestShopifyWebhook(input),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.receiptsByComposite.size).toBe(1);
    expect(store.outboxesByReceiptId.size).toBe(1);
  });

  it("persists IGNORED receipts for unsupported cart topics", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      baseInput({
        topic: "CARTS_CREATE",
        payload: { cart_id: "cart-1" },
      }),
    );

    expect(response.status).toBe(200);
    const data = lastReceiptCreateData();
    expect(data.disposition).toBe("IGNORED");
    expect(data.dispositionCode).toBe("UNSUPPORTED_TOPIC");
    expect(data.outbox).toBeUndefined();
    expect(store.outboxesByReceiptId.size).toBe(0);
  });

  it("persists REJECTED receipts for supported payloads missing a checkout token", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    const response = await ingestShopifyWebhook(
      baseInput({
        topic: "ORDERS_CREATE",
        payload: {
          current_total_price: "19.99",
          currency: "USD",
        },
      }),
    );

    expect(response.status).toBe(200);
    const data = lastReceiptCreateData();
    expect(data.disposition).toBe("REJECTED");
    expect(data.dispositionCode).toBe("MISSING_CHECKOUT_TOKEN");
    expect(data.outbox).toBeUndefined();
  });

  it("persists QUARANTINED receipts for unknown or inactive tenants", async () => {
    store.shopsByDomain.set("inactive.myshopify.com", inactiveShop());

    const unknownTenantResponse = await ingestShopifyWebhook(
      baseInput({
        shop: "missing.myshopify.com",
      }),
    );

    expect(unknownTenantResponse.status).toBe(200);
    expect(lastReceiptCreateData().disposition).toBe("QUARANTINED");
    expect(lastReceiptCreateData().shopId).toBeNull();

    resetStore();
    store.shopsByDomain.set("inactive.myshopify.com", inactiveShop());

    const inactiveTenantResponse = await ingestShopifyWebhook(
      baseInput({
        shop: "inactive.myshopify.com",
      }),
    );

    expect(inactiveTenantResponse.status).toBe(200);
    expect(lastReceiptCreateData().disposition).toBe("QUARANTINED");
    expect(lastReceiptCreateData().shopId).toBeNull();
  });

  it("returns 400 and creates no receipt when delivery ids are missing or conflicting", async () => {
    const missingDeliveryResponse = await ingestShopifyWebhook(
      baseInput({
        request: new Request("https://app.example/webhooks", {
          method: "POST",
        }),
      }),
    );

    expect(missingDeliveryResponse.status).toBe(400);
    expect(dbMock.shopifyWebhookReceipt.create).not.toHaveBeenCalled();

    const conflictingDeliveryResponse = await ingestShopifyWebhook(
      baseInput({
        request: baseRequest({
          "X-Shopify-Webhook-Id": "delivery-a",
          "Webhook-Id": "delivery-b",
        }),
      }),
    );

    expect(conflictingDeliveryResponse.status).toBe(400);
    expect(dbMock.shopifyWebhookReceipt.create).not.toHaveBeenCalled();
  });

  it("returns non-2xx when the transaction fails", async () => {
    dbMock.$transaction.mockRejectedValueOnce(new Error("database down"));
    store.shopsByDomain.set("shop.myshopify.com", activeShop());

    await expect(ingestShopifyWebhook(baseInput())).rejects.toThrow(
      "database down",
    );
    expect(store.receiptsByComposite.size).toBe(0);
    expect(store.outboxesByReceiptId.size).toBe(0);
  });

  it("logs structured PII-safe output", async () => {
    store.shopsByDomain.set("shop.myshopify.com", activeShop());
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await ingestShopifyWebhook(
      baseInput({
        payload: {
          token: "checkout-token-1",
          customer: {
            email: "customer@example.com",
            phone: "+15555550100",
          },
          hmac: "super-secret-hmac-value",
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
    expect(logLine).toContain("internalEventType");
    expect(logLine).toContain("transactionMs");
    expect(logLine).toContain("ackMs");
    expect(logLine).not.toContain("customer@example.com");
    expect(logLine).not.toContain("+15555550100");
    expect(logLine).not.toContain("super-secret-hmac-value");

    infoSpy.mockRestore();
  });
});
