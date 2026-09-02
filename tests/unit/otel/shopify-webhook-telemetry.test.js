import { SpanStatusCode, context, metrics, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OTEL_WEBHOOK_METRIC_DURATION,
  OTEL_WEBHOOK_METRIC_INGRESS,
  OTEL_WEBHOOK_METER_NAME,
  OTEL_WEBHOOK_SPAN_NAME,
} from "../../../app/services/otel/otel.constants";
import {
  getActiveTraceId,
} from "../../../app/services/otel/otel.runtime";
let traceExporter;
let metricExporter;
let traceProvider;
let meterProvider;
let metricReader;
let contextManager;
let recordShopifyWebhookTelemetry;

const baseEntry = {
  topic: "orders/create",
  deliveryId: "delivery-1",
  eventId: "event-1",
  queue: "order-events",
  jobId: "job-1",
  outcome: "ENQUEUED",
  shopId: "shop_1",
  shopDomain: "shop.myshopify.com",
  ackMs: 42,
};

function startProviders() {
  traceExporter = new InMemorySpanExporter();
  traceProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(traceExporter)],
  });
  traceProvider.register();

  metricExporter = new InMemoryMetricExporter(
    AggregationTemporality.DELTA,
  );
  metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  contextManager = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(contextManager);
}

beforeAll(async () => {
  startProviders();
  ({ recordShopifyWebhookTelemetry } = await import(
    "../../../app/services/otel/shopify-webhook-telemetry.server"
  ));
});

beforeEach(async () => {
  await meterProvider.forceFlush();
  traceExporter.reset();
  metricExporter.reset();
});

afterAll(async () => {
  await traceProvider.shutdown();
  await meterProvider.shutdown();
  await contextManager.disable();
  trace.disable();
  metrics.disable();
  context.disable();
});

function findMetric(resourceMetrics, name) {
  for (const resourceMetric of resourceMetrics) {
    for (const scope of resourceMetric.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name === name) {
          return metric;
        }
      }
    }
  }
  return undefined;
}

describe("Shopify webhook OpenTelemetry recording", () => {
  it("exports a completed span with allowlisted attributes", async () => {
    recordShopifyWebhookTelemetry({
      ...baseEntry,
      eventType: "order.completed",
      statusCode: 200,
    });

    await traceProvider.forceFlush();

    const span = traceExporter
      .getFinishedSpans()
      .find((candidate) => candidate.name === OTEL_WEBHOOK_SPAN_NAME);

    expect(span).toBeDefined();
    expect(span.attributes).toMatchObject({
      "shopify.webhook.topic": "orders/create",
      "shopify.webhook.event_type": "order.completed",
      "shopify.webhook.outcome": "ENQUEUED",
      "shopify.webhook.queue": "order-events",
      "shopify.webhook.status_code": 200,
    });
    // PII never reaches telemetry attributes.
    expect(Object.values(span.attributes)).not.toContain("shop.myshopify.com");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("marks the span as an error for failed outcomes", async () => {
    recordShopifyWebhookTelemetry({
      ...baseEntry,
      outcome: "REDIS_UNAVAILABLE",
      eventType: null,
      statusCode: null,
    });

    await traceProvider.forceFlush();

    const span = traceExporter
      .getFinishedSpans()
      .find((candidate) => candidate.name === OTEL_WEBHOOK_SPAN_NAME);

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("shopify_webhook_REDIS_UNAVAILABLE");
  });

  it("records bounded ingress and duration metrics", async () => {
    recordShopifyWebhookTelemetry({
      ...baseEntry,
      eventType: "order.completed",
      statusCode: 200,
    });

    await meterProvider.forceFlush();

    const resourceMetrics = metricExporter.getMetrics();

    const ingress = findMetric(resourceMetrics, OTEL_WEBHOOK_METRIC_INGRESS);
    expect(ingress).toBeDefined();
    expect(ingress.dataPoints).toHaveLength(1);
    expect(ingress.dataPoints[0].value).toBe(1);
    expect(ingress.dataPoints[0].attributes).toEqual({
      "shopify.webhook.topic": "orders/create",
      "shopify.webhook.event_type": "order.completed",
      "shopify.webhook.outcome": "ENQUEUED",
      "shopify.webhook.queue": "order-events",
      "shopify.webhook.status_code": 200,
    });

    const duration = findMetric(resourceMetrics, OTEL_WEBHOOK_METRIC_DURATION);
    expect(duration).toBeDefined();
    expect(duration.dataPoints[0].value.sum).toBe(42);
    expect(duration.dataPoints[0].value.count).toBe(1);
  });

  it("returns the active span trace id once the SDK is recording", () => {
    const tracer = trace.getTracer("otel-test");
    const span = tracer.startSpan("test-span");

    const activeTraceId = context.with(
      trace.setSpan(context.active(), span),
      () => getActiveTraceId("fallback-trace-id"),
    );
    const idleTraceId = getActiveTraceId("fallback-trace-id");

    expect(activeTraceId).toBe(span.spanContext().traceId);
    expect(idleTraceId).toBe("fallback-trace-id");

    span.end();
  });
});
