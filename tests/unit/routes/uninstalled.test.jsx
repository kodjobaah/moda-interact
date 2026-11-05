import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateWebhook: vi.fn(),
  markUninstalled: vi.fn(),
  webhookReceived: vi.fn(),
  webhookAuthFailure: vi.fn(),
  webhookRouteFailure: vi.fn(),
  webhookRouteOutcome: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { webhook: mocks.authenticateWebhook },
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { markUninstalled: mocks.markUninstalled },
}));
vi.mock("../../../app/services/webhooks/shopify-webhook-observability.server", () => ({
  recordShopifyWebhookReceived: mocks.webhookReceived,
  recordShopifyWebhookAuthenticationFailure: mocks.webhookAuthFailure,
  recordShopifyWebhookRouteFailure: mocks.webhookRouteFailure,
  recordShopifyWebhookRouteOutcome: mocks.webhookRouteOutcome,
}));

import { action } from "../../../app/routes/webhooks/app/uninstalled/route";

const webhookRequest = () => new Request("https://example.test/webhooks/app/uninstalled", {
  method: "POST",
  headers: { "x-shopify-webhook-id": "uninstall-delivery-1" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateWebhook.mockResolvedValue({
    shop: "merchant.myshopify.com",
    session: { id: "old-session" },
    topic: "APP_UNINSTALLED",
    eventId: "uninstall-event-1",
    triggeredAt: "2026-11-04T20:00:00.000Z",
  });
});

describe("APP_UNINSTALLED route persistence boundary", () => {
  it.each([
    [{ kind: "UNINSTALLED", shopId: "shop-1", deletedSessionCount: 1 }, "PROCESSED_APP_UNINSTALLED"],
    [{ kind: "ALREADY_UNINSTALLED", shopId: "shop-1" }, "DUPLICATE_APP_UNINSTALLED"],
    [{ kind: "SHOP_NOT_FOUND" }, "APP_UNINSTALLED_SHOP_NOT_FOUND"],
  ])("acknowledges committed service result %s", async (result, outcome) => {
    mocks.markUninstalled.mockResolvedValue(result);

    await expect(action({ request: webhookRequest() })).resolves.toBeInstanceOf(Response);

    expect(mocks.markUninstalled).toHaveBeenCalledWith(
      "merchant.myshopify.com",
      new Date("2026-11-04T20:00:00.000Z"),
    );
    expect(mocks.webhookRouteOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome,
      shopDomain: "merchant.myshopify.com",
      eventId: "uninstall-event-1",
    }));
    expect(mocks.webhookRouteFailure).not.toHaveBeenCalled();
  });

  it("reports a failed atomic service transaction and rethrows the same error", async () => {
    const error = Object.assign(new Error("uninstall transaction failure marker"), { code: "P2034" });
    mocks.markUninstalled.mockRejectedValue(error);

    await expect(action({ request: webhookRequest() })).rejects.toBe(error);

    expect(mocks.webhookRouteFailure).toHaveBeenCalledWith(expect.objectContaining({
      operation: "mark_uninstalled",
      stage: "transaction",
      origin: "database",
      error,
      shopDomain: "merchant.myshopify.com",
    }));
    expect(mocks.webhookRouteOutcome).not.toHaveBeenCalled();
  });
});