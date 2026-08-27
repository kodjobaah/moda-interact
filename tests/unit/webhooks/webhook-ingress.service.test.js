import { beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";

vi.mock("../../../app/services/webhooks/dispatch/legacy-dispatch.server", () => ({
  dispatchLegacy: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));
vi.mock("../../../app/services/webhooks/dispatch/outbox-dispatch.server", () => ({
  dispatchOutbox: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));

const { ingestShopifyWebhook, getWebhookDispatchMode } = await import(
  "../../../app/services/webhooks/webhook-ingress.service"
);
const { dispatchLegacy } = await import(
  "../../../app/services/webhooks/dispatch/legacy-dispatch.server"
);
const { dispatchOutbox } = await import(
  "../../../app/services/webhooks/dispatch/outbox-dispatch.server"
);

function baseInput(overrides = {}) {
  return {
    request: new Request("https://app.example/webhooks", {
      method: "POST",
      headers: { "X-Shopify-Webhook-Id": "delivery-1" },
    }),
    appKey: "app-key",
    shop: "shop.myshopify.com",
    topic: "ORDERS_CREATE",
    payload: { admin_graphql_api_id: "gid://shopify/Order/1" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WEBHOOK_DISPATCH_MODE;
});

describe("getWebhookDispatchMode", () => {
  it("defaults to legacy", () => {
    expect(getWebhookDispatchMode()).toBe("legacy");
  });

  it("only switches to outbox on an explicit opt-in", () => {
    process.env.WEBHOOK_DISPATCH_MODE = "outbox";
    expect(getWebhookDispatchMode()).toBe("outbox");
    process.env.WEBHOOK_DISPATCH_MODE = "something-else";
    expect(getWebhookDispatchMode()).toBe("legacy");
  });
});

describe("ingestShopifyWebhook", () => {
  it("returns 400 and writes nothing when the delivery ID is missing", async () => {
    const input = baseInput({
      request: new Request("https://app.example/webhooks", { method: "POST" }),
    });
    const response = await ingestShopifyWebhook(input);
    expect(response.status).toBe(400);
    expect(dispatchLegacy).not.toHaveBeenCalled();
    expect(dispatchOutbox).not.toHaveBeenCalled();
  });

  it("returns 400 and writes nothing when delivery headers conflict", async () => {
    const input = baseInput({
      request: new Request("https://app.example/webhooks", {
        method: "POST",
        headers: {
          "X-Shopify-Webhook-Id": "a",
          "Webhook-Id": "b",
        },
      }),
    });
    const response = await ingestShopifyWebhook(input);
    expect(response.status).toBe(400);
    expect(dispatchLegacy).not.toHaveBeenCalled();
    expect(dispatchOutbox).not.toHaveBeenCalled();
  });

  it("routes to legacy dispatch by default", async () => {
    await ingestShopifyWebhook(baseInput());
    expect(dispatchLegacy).toHaveBeenCalledTimes(1);
    expect(dispatchOutbox).not.toHaveBeenCalled();
  });

  it("routes to outbox dispatch only when explicitly enabled", async () => {
    process.env.WEBHOOK_DISPATCH_MODE = "outbox";
    await ingestShopifyWebhook(baseInput());
    expect(dispatchOutbox).toHaveBeenCalledTimes(1);
    expect(dispatchLegacy).not.toHaveBeenCalled();
  });
});
