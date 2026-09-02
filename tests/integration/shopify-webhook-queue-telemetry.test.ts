import { context, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import {
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS,
  ShopifyOrderCompletedEventV2Schema,
} from "@modainteract/moda-interact-shared/shopify";
import { Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  shop: {
    findUnique: vi.fn(async () => ({
      id: "shop_telemetry",
      domain: "telemetry.myshopify.com",
      status: "ACTIVE",
    })),
  },
};

vi.mock("../../app/db.server", () => ({ default: dbMock }));

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)("Shopify Queue telemetry continuity", () => {
  let contextManager: AsyncHooksContextManager | undefined;
  let traceProvider: NodeTracerProvider | undefined;
  let worker: Worker | undefined;

  afterEach(async () => {
    await worker?.close();
    const queueModule = await import(
      "../../app/services/webhooks/shopify-webhook-queue.server"
    );
    await queueModule.resetShopifyWebhookQueuesForTests();
    await traceProvider?.shutdown();
    await contextManager?.disable();
    trace.disable();
    context.disable();
    delete process.env.REDIS_URL;
  });

  it("continues the webhook trace without changing the business payload", async () => {
    const spans: ReadableSpan[] = [];
    const exporter: SpanExporter = {
      export(exportedSpans, callback) {
        spans.push(...exportedSpans);
        callback({ code: 0 });
      },
      shutdown: async () => {},
    };
    traceProvider = new NodeTracerProvider({
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    traceProvider.register();
    contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);

    process.env.REDIS_URL = redisUrl;
    const queueModule = await import(
      "../../app/services/webhooks/shopify-webhook-queue.server"
    );
    const { ingestShopifyWebhook } = await import(
      "../../app/services/webhooks/shopify-webhook-ingress.service"
    );
    const workerTelemetry = createBullMQTelemetry({
      serviceName: "moda-shopify-event-worker",
      enableMetrics: false,
    });
    const connection = { url: redisUrl, maxRetriesPerRequest: null };
    let complete: ((data: unknown) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const processed = new Promise<unknown>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    worker = new Worker(
      SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
      async () => "processed",
      { connection, telemetry: workerTelemetry },
    );
    worker.once("completed", (job) => complete?.(job.data));
    worker.once("failed", (_job, error) => fail?.(error));
    await worker.waitUntilReady();

    let response;
    let processedData;
    await trace.getTracer("moda-interact.shopify.webhooks").startActiveSpan(
      "shopify.webhook.receive",
      async (span) => {
        response = await ingestShopifyWebhook({
          request: new Request("https://app.example/webhooks", {
            method: "POST",
            headers: {
              "X-Shopify-Webhook-Id": `delivery-${process.pid}`,
            },
          }),
          appKey: "app-key",
          shop: "telemetry.myshopify.com",
          topic: "ORDERS_CREATE",
          payload: {
            admin_graphql_api_id: `gid://shopify/Order/${process.pid}`,
            checkout_token: null,
            cart_token: null,
            created_at: "2026-08-31T00:00:00.000Z",
          },
          apiVersion: "2026-07",
          eventId: `event-${process.pid}`,
          triggeredAt: "2026-08-31T00:00:00.000Z",
          name: "orders/create",
        });
        processedData = await processed;
        span.end();
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await traceProvider.forceFlush();

    expect(response).toMatchObject({ status: 200 });
    const event = ShopifyOrderCompletedEventV2Schema.parse(processedData);
    expect(event).toMatchObject({
      deliveryId: `delivery-${process.pid}`,
      eventType: "order.completed",
      tenant: {
        shopId: "shop_telemetry",
        shopDomain: "telemetry.myshopify.com",
      },
      payload: {
        orderId: `gid://shopify/Order/${process.pid}`,
        checkoutToken: null,
        cartToken: null,
      },
    });
    const relevantSpans = spans.filter((span) =>
      /shopify\.webhook\.receive|add order-events|process order-events/.test(
        span.name,
      ),
    );
    expect(relevantSpans.some((span) => span.name === "shopify.webhook.receive")).toBe(true);
    expect(relevantSpans.some((span) => span.name.startsWith("add order-events"))).toBe(true);
    expect(
      relevantSpans.some((span) => span.name.startsWith("process order-events")),
      `captured spans: ${spans.map((span) => span.name).join(", ")}`,
    ).toBe(true);
    expect(new Set(relevantSpans.map((span) => span.spanContext().traceId)).size).toBe(1);

    await worker.close();
    worker = undefined;
    await queueModule.resetShopifyWebhookQueuesForTests();
    await traceProvider.shutdown();
    traceProvider = undefined;
    await contextManager.disable();
    contextManager = undefined;
    trace.disable();
    context.disable();

    let completeWithoutTelemetry: (() => void) | undefined;
    let failWithoutTelemetry: ((error: Error) => void) | undefined;
    const processedWithoutTelemetry = new Promise<void>((resolve, reject) => {
      completeWithoutTelemetry = resolve;
      failWithoutTelemetry = reject;
    });
    worker = new Worker(
      SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
      async () => "processed-without-telemetry",
      {
        connection,
        telemetry: createBullMQTelemetry({
          serviceName: "moda-shopify-event-worker",
          enableMetrics: false,
        }),
      },
    );
    worker.once("completed", () => completeWithoutTelemetry?.());
    worker.once("failed", (_job, error) => failWithoutTelemetry?.(error));
    await worker.waitUntilReady();

    const eventWithoutTelemetry = ShopifyOrderCompletedEventV2Schema.parse({
      ...event,
      receiptId: `receipt-disabled-${process.pid}`,
      deliveryId: `delivery-disabled-${process.pid}`,
      eventId: `event-disabled-${process.pid}`,
      traceId: `request-disabled-${process.pid}`,
      orderingKey: `shop_telemetry:gid://shopify/Order/disabled-${process.pid}`,
      payload: {
        ...event.payload,
        orderId: `gid://shopify/Order/disabled-${process.pid}`,
      },
    });
    const publicationWithoutTelemetry =
      await queueModule.publishShopifyOrderCompletedEvent({
        event: eventWithoutTelemetry,
      });
    await processedWithoutTelemetry;

    expect(publicationWithoutTelemetry).toMatchObject({ outcome: "enqueued" });
  });
});