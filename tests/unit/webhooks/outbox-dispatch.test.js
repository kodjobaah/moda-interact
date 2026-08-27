import { beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";
import { Prisma } from "@prisma/client";

const dbMock = {
  shop: { findUnique: vi.fn() },
  shopifyWebhookReceipt: {
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
};

vi.mock("../../../app/db.server", () => ({ default: dbMock }));
vi.mock("../../../app/services/webhooks/checkout-delay.server", () => ({
  resolveCheckoutDelayMs: vi.fn().mockResolvedValue(1_800_000),
}));

const { dispatchOutbox } = await import(
  "../../../app/services/webhooks/dispatch/outbox-dispatch.server"
);

function metadata(overrides = {}) {
  return {
    appKey: "app-key",
    deliveryId: "delivery-1",
    eventId: "event-1",
    shopDomain: "shop.myshopify.com",
    topic: "ORDERS_CREATE",
    apiVersion: "2026-07",
    triggeredAt: new Date("2024-01-01T00:00:00Z"),
    triggeredAtRaw: "2024-01-01T00:00:00Z",
    subscriptionName: null,
    receivedAt: new Date("2024-01-01T00:00:01Z"),
    ...overrides,
  };
}

function conflictError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.19.3",
    meta: { target: ["appKey", "deliveryId"] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatchOutbox", () => {
  it("creates one receipt and one nested outbox for a valid order payload", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockResolvedValue({
      id: "receipt_1",
      disposition: "ACCEPTED",
      outbox: { id: "outbox_1", jobName: "order-completed" },
    });

    const response = await dispatchOutbox(
      metadata(),
      { admin_graphql_api_id: "gid://shopify/Order/1" },
      Date.now(),
    );

    expect(response.status).toBe(200);
    expect(dbMock.shopifyWebhookReceipt.create).toHaveBeenCalledTimes(1);
    const call = dbMock.shopifyWebhookReceipt.create.mock.calls[0][0];
    expect(call.data.disposition).toBe("ACCEPTED");
    expect(call.data.outbox.create.destination).toBe("ORDER_EVENTS");
    expect(call.data.outbox.create.jobName).toBe("order-completed");
    expect(call.data.outbox.create.state).toBe("PENDING");
  });

  it("creates one receipt and one nested outbox for a valid checkout payload", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockResolvedValue({
      id: "receipt_2",
      disposition: "ACCEPTED",
      outbox: { id: "outbox_2" },
    });

    await dispatchOutbox(
      metadata({ topic: "CHECKOUTS_CREATE", deliveryId: "delivery-2" }),
      { token: "checkout-token-1" },
      Date.now(),
    );

    const call = dbMock.shopifyWebhookReceipt.create.mock.calls[0][0];
    expect(call.data.outbox.create.destination).toBe("CHECKOUT_EVENTS");
    expect(call.data.outbox.create.jobName).toBe("checkout-created");
    expect(call.data.outbox.create.delayMs).toBe(1_800_000);
  });

  it("records an IGNORED receipt with no outbox for a cart topic", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockResolvedValue({
      id: "receipt_3",
      disposition: "IGNORED",
    });

    const response = await dispatchOutbox(
      metadata({ topic: "CARTS_CREATE" }),
      { id: 1 },
      Date.now(),
    );

    expect(response.status).toBe(200);
    const call = dbMock.shopifyWebhookReceipt.create.mock.calls[0][0];
    expect(call.data.disposition).toBe("IGNORED");
    expect(call.data.outbox).toBeUndefined();
  });

  it("records an IGNORED receipt with no outbox for an unknown topic", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockResolvedValue({
      id: "receipt_4",
      disposition: "IGNORED",
    });

    await dispatchOutbox(
      metadata({ topic: "PRODUCTS_CREATE" }),
      { id: 1 },
      Date.now(),
    );

    const call = dbMock.shopifyWebhookReceipt.create.mock.calls[0][0];
    expect(call.data.disposition).toBe("IGNORED");
  });

  it("records a REJECTED receipt with the payload retained, and no outbox, for an invalid order", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockResolvedValue({
      id: "receipt_5",
      disposition: "REJECTED",
    });

    const response = await dispatchOutbox(
      metadata(),
      { total_price: "1.00" }, // missing admin_graphql_api_id
      Date.now(),
    );

    expect(response.status).toBe(200);
    const call = dbMock.shopifyWebhookReceipt.create.mock.calls[0][0];
    expect(call.data.disposition).toBe("REJECTED");
    expect(call.data.rejectedPayload).toEqual({ total_price: "1.00" });
    expect(call.data.outbox).toBeUndefined();
  });

  it("records a QUARANTINED receipt for an unknown tenant with no outbox", async () => {
    dbMock.shop.findUnique.mockResolvedValue(null);
    dbMock.shopifyWebhookReceipt.create.mockResolvedValue({
      id: "receipt_6",
      disposition: "QUARANTINED",
    });

    const response = await dispatchOutbox(
      metadata({ shopDomain: "unknown.myshopify.com" }),
      { admin_graphql_api_id: "gid://shopify/Order/1" },
      Date.now(),
    );

    expect(response.status).toBe(200);
    const call = dbMock.shopifyWebhookReceipt.create.mock.calls[0][0];
    expect(call.data.disposition).toBe("QUARANTINED");
    expect(call.data.shopId).toBeNull();
    expect(call.data.outbox).toBeUndefined();
  });

  it("treats a sequential duplicate delivery as a duplicate success without a second write", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockRejectedValueOnce(conflictError());
    dbMock.shopifyWebhookReceipt.findUniqueOrThrow.mockResolvedValue({
      id: "receipt_7",
      disposition: "ACCEPTED",
    });

    const response = await dispatchOutbox(
      metadata(),
      { admin_graphql_api_id: "gid://shopify/Order/1" },
      Date.now(),
    );

    expect(response.status).toBe(200);
    expect(dbMock.shopifyWebhookReceipt.create).toHaveBeenCalledTimes(1);
    expect(dbMock.shopifyWebhookReceipt.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });

  it("treats concurrent duplicate deliveries as a single committed receipt", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create
      .mockResolvedValueOnce({ id: "receipt_8", disposition: "ACCEPTED" })
      .mockRejectedValueOnce(conflictError());
    dbMock.shopifyWebhookReceipt.findUniqueOrThrow.mockResolvedValue({
      id: "receipt_8",
      disposition: "ACCEPTED",
    });

    const payload = { admin_graphql_api_id: "gid://shopify/Order/1" };
    const meta = metadata();

    const [first, second] = await Promise.all([
      dispatchOutbox(meta, payload, Date.now()),
      dispatchOutbox(meta, payload, Date.now()),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(dbMock.shopifyWebhookReceipt.create).toHaveBeenCalledTimes(2);
    expect(dbMock.shopifyWebhookReceipt.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });

  it("creates separate receipts for the same eventId under different deliveryIds", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create
      .mockResolvedValueOnce({ id: "receipt_9", disposition: "ACCEPTED" })
      .mockResolvedValueOnce({ id: "receipt_10", disposition: "ACCEPTED" });

    const payload = { admin_graphql_api_id: "gid://shopify/Order/1" };
    await dispatchOutbox(
      metadata({ deliveryId: "delivery-a", eventId: "shared-event" }),
      payload,
      Date.now(),
    );
    await dispatchOutbox(
      metadata({ deliveryId: "delivery-b", eventId: "shared-event" }),
      payload,
      Date.now(),
    );

    expect(dbMock.shopifyWebhookReceipt.create).toHaveBeenCalledTimes(2);
    expect(dbMock.shopifyWebhookReceipt.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("rolls back (creates nothing) when the receipt+outbox write fails", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );

    await expect(
      dispatchOutbox(
        metadata(),
        { admin_graphql_api_id: "gid://shopify/Order/1" },
        Date.now(),
      ),
    ).rejects.toThrow("connection terminated unexpectedly");

    // A single failing nested-create call means no partial receipt/outbox exists.
    expect(dbMock.shopifyWebhookReceipt.create).toHaveBeenCalledTimes(1);
  });

  it("propagates database failures instead of returning 200", async () => {
    dbMock.shop.findUnique.mockRejectedValue(new Error("db unreachable"));

    await expect(
      dispatchOutbox(
        metadata(),
        { admin_graphql_api_id: "gid://shopify/Order/1" },
        Date.now(),
      ),
    ).rejects.toThrow("db unreachable");
  });

  it("propagates unrelated P2002 conflicts instead of swallowing them", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    const unrelated = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: ["jobId"] },
      },
    );
    dbMock.shopifyWebhookReceipt.create.mockRejectedValue(unrelated);

    await expect(
      dispatchOutbox(
        metadata(),
        { admin_graphql_api_id: "gid://shopify/Order/1" },
        Date.now(),
      ),
    ).rejects.toBe(unrelated);
  });

  it("does not import Redis or BullMQ", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "app/services/webhooks/dispatch/outbox-dispatch.server.js",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/^import .*(bullmq|ioredis|queues\/).*$/im);
  });
});
