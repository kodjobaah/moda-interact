import { beforeEach, describe, expect, it, vi } from "vitest";

const queueAddMock = vi.fn().mockResolvedValue({ id: "job-1" });
const ordersAddMock = vi.fn().mockResolvedValue({ id: "job-2", name: "order-completed", queueName: "order-events" });

vi.mock("../../../app/lib/queues/checkout.queue", () => ({
  getCheckoutQueue: () => ({ add: queueAddMock }),
}));
vi.mock("../../../app/lib/queues/order.server", () => ({
  ordersQueue: { add: ordersAddMock },
}));
vi.mock("../../../app/services/webhooks/checkout-delay.server", () => ({
  resolveCheckoutDelayMs: vi.fn().mockResolvedValue(1_800_000),
}));

const { dispatchLegacy } = await import(
  "../../../app/services/webhooks/dispatch/legacy-dispatch.server"
);
const { buildWebhookJobId } = await import(
  "../../../app/services/webhooks/job-id"
);

function metadata(overrides = {}) {
  return {
    appKey: "app-key",
    deliveryId: "delivery-1",
    eventId: "event-1",
    shopDomain: "shop.myshopify.com",
    topic: "ORDERS_CREATE",
    apiVersion: "2026-07",
    triggeredAt: new Date(),
    triggeredAtRaw: "2024-01-01T00:00:00Z",
    subscriptionName: null,
    receivedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatchLegacy", () => {
  it("publishes checkouts/create with the deterministic job ID and resolved delay", async () => {
    await dispatchLegacy(
      metadata({ topic: "CHECKOUTS_CREATE" }),
      { token: "checkout-token-1" },
      Date.now(),
    );

    expect(queueAddMock).toHaveBeenCalledWith(
      "checkout-created",
      expect.objectContaining({ checkoutToken: "checkout-token-1" }),
      {
        jobId: buildWebhookJobId("app-key", "delivery-1"),
        delay: 1_800_000,
      },
    );
  });

  it("publishes orders/create with the deterministic job ID and no delay option", async () => {
    await dispatchLegacy(
      metadata({ topic: "ORDERS_CREATE" }),
      { admin_graphql_api_id: "gid://shopify/Order/1" },
      Date.now(),
    );

    expect(ordersAddMock).toHaveBeenCalledWith(
      "order-completed",
      expect.objectContaining({ orderId: "gid://shopify/Order/1" }),
      { jobId: buildWebhookJobId("app-key", "delivery-1") },
    );
  });

  it("produces the same job ID across repeated deliveries (BullMQ dedupe)", async () => {
    await dispatchLegacy(
      metadata({ topic: "ORDERS_CREATE" }),
      { admin_graphql_api_id: "gid://shopify/Order/1" },
      Date.now(),
    );
    await dispatchLegacy(
      metadata({ topic: "ORDERS_CREATE" }),
      { admin_graphql_api_id: "gid://shopify/Order/1" },
      Date.now(),
    );

    const [firstCallJobId] = [ordersAddMock.mock.calls[0][2].jobId];
    const [secondCallJobId] = [ordersAddMock.mock.calls[1][2].jobId];
    expect(firstCallJobId).toBe(secondCallJobId);
    expect(firstCallJobId).not.toContain(":");
  });

  it("does not publish for cart topics", async () => {
    await dispatchLegacy(metadata({ topic: "CARTS_CREATE" }), { id: 1 }, Date.now());
    expect(queueAddMock).not.toHaveBeenCalled();
    expect(ordersAddMock).not.toHaveBeenCalled();
  });
});
