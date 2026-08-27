import { beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";

class ExplodingRedis {
  constructor() {
    throw new Error("Redis is offline");
  }
}

vi.mock("ioredis", () => ({ default: ExplodingRedis }));

const dbMock = {
  shop: { findUnique: vi.fn() },
  shopifyWebhookReceipt: {
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
};
vi.mock("../../../app/db.server", () => ({ default: dbMock }));
vi.mock("../../../app/services/webhooks/checkout-delay.server", () => ({
  resolveCheckoutDelayMs: vi.fn().mockResolvedValue(0),
}));

const { ingestShopifyWebhook } = await import(
  "../../../app/services/webhooks/webhook-ingress.service"
);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WEBHOOK_DISPATCH_MODE = "outbox";
});

describe("outbox mode with Redis offline", () => {
  it("still acknowledges 200 without ever constructing a Redis connection", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockResolvedValue({
      id: "receipt_1",
      disposition: "ACCEPTED",
      outbox: { id: "outbox_1" },
    });

    const request = new Request("https://app.example/webhooks", {
      method: "POST",
      headers: { "X-Shopify-Webhook-Id": "delivery-1" },
    });

    const response = await ingestShopifyWebhook({
      request,
      appKey: "app-key",
      shop: "shop.myshopify.com",
      topic: "ORDERS_CREATE",
      payload: { admin_graphql_api_id: "gid://shopify/Order/1" },
    });

    expect(response.status).toBe(200);
    // The ExplodingRedis constructor above never fires, proving the outbox
    // path never touched ioredis/BullMQ.
  });
});
