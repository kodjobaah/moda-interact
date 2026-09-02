import { context, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const store = {
  shopsByDomain: new Map(),
};

const dbMock = {
  shop: {
    findUnique: vi.fn(async ({ where }) => store.shopsByDomain.get(where.domain) ?? null),
  },
};

const publicationMock = {
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

function activeShop() {
  return {
    id: "shop_1",
    domain: "shop.myshopify.com",
    status: "ACTIVE",
  };
}

function checkoutInput() {
  return {
    request: new Request("https://app.example/webhooks", {
      method: "POST",
      headers: {
        "X-Shopify-Webhook-Id": "delivery-1",
      },
    }),
    appKey: "app-key",
    shop: "shop.myshopify.com",
    topic: "CHECKOUTS_CREATE",
    payload: {
      token: "checkout-token-1",
      created_at: "2024-01-01T00:00:00Z",
    },
    apiVersion: "2026-07",
    eventId: "event-1",
    triggeredAt: "2024-01-01T00:00:00Z",
    name: "checkout/create",
  };
}

let contextManager;

beforeAll(() => {
  contextManager = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(contextManager);
});

afterAll(async () => {
  await contextManager.disable();
  context.disable();
});

beforeEach(() => {
  store.shopsByDomain.clear();
  store.shopsByDomain.set("shop.myshopify.com", activeShop());
  publicationMock.publishShopifyCheckoutCreatedEvent.mockClear();
});

describe("OpenTelemetry trace propagation into recovery events", () => {
  it("records the active OpenTelemetry trace id on the published event", async () => {
    const span = trace.wrapSpanContext({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: 1,
    });

    await context.with(trace.setSpan(context.active(), span), async () => {
      const response = await ingestShopifyWebhook(checkoutInput());

      expect(response.status).toBe(200);
      const publishedEvent =
        publicationMock.publishShopifyCheckoutCreatedEvent.mock.calls[0][0].event;
      expect(publishedEvent.traceId).toBe(span.spanContext().traceId);
    });

    span.end();
  });

  it("falls back to the generated request id when no span is active", async () => {
    const response = await ingestShopifyWebhook(checkoutInput());

    expect(response.status).toBe(200);
    const publishedEvent =
      publicationMock.publishShopifyCheckoutCreatedEvent.mock.calls[0][0].event;
    expect(publishedEvent.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
