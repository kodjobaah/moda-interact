import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { dispatchOutbox } = await import(
  "../../../app/services/webhooks/dispatch/outbox-dispatch.server"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("webhook logging", () => {
  it("never logs raw payload content, PII, or HMAC values", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    dbMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
    dbMock.shopifyWebhookReceipt.create.mockResolvedValue({
      id: "receipt_1",
      disposition: "ACCEPTED",
      outbox: { id: "outbox_1" },
    });

    const secretHmac = "super-secret-hmac-value";
    const piiEmail = "jane.doe@example.com";

    await dispatchOutbox(
      {
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
      },
      {
        admin_graphql_api_id: "gid://shopify/Order/1",
        customer: { email: piiEmail },
        hmac: secretHmac,
      },
      Date.now(),
    );

    const serializedLogs = logSpy.mock.calls
      .map((call) => call.map(String).join(" "))
      .join("\n");

    expect(serializedLogs).not.toContain(secretHmac);
    expect(serializedLogs).not.toContain(piiEmail);
    logSpy.mockRestore();
  });
});
