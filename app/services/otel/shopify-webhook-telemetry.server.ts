import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";
import type { ShopifyWebhookObservation } from "../webhooks/shopify-webhook-observation";
import {
  OTEL_WEBHOOK_METER_NAME,
  OTEL_WEBHOOK_METRIC_DURATION,
  OTEL_WEBHOOK_METRIC_INGRESS,
  OTEL_WEBHOOK_SPAN_NAME,
  OTEL_WEBHOOK_TRACER_NAME,
} from "./otel.constants";

/**
 * Telemetry entry for a Shopify webhook processing outcome. Extends the
 * structured log entry with optional dimensions that are allowed on spans.
 */
export type ShopifyWebhookTelemetryEntry = ShopifyWebhookObservation & {
  eventType?: string | null;
  statusCode?: number | null;
};

/** Outcomes that result in an accepted (non-error) webhook response. */
const ACCEPTED_OUTCOMES = new Set([
  "ENQUEUED",
  "DUPLICATE",
  "IGNORED",
  "QUARANTINED",
]);

const tracer = trace.getTracer(OTEL_WEBHOOK_TRACER_NAME);
const meter = metrics.getMeter(OTEL_WEBHOOK_METER_NAME);
const ingress = meter.createCounter(OTEL_WEBHOOK_METRIC_INGRESS, {
  description: "Shopify webhook deliveries processed by outcome.",
  unit: "1",
});
const duration = meter.createHistogram(OTEL_WEBHOOK_METRIC_DURATION, {
  description:
    "Duration in milliseconds to acknowledge a Shopify webhook delivery.",
  unit: "ms",
});

/**
 * Records one bounded telemetry event for a Shopify webhook processing
 * outcome: a `shopify.webhook.process` span plus an ingress counter and a
 * duration histogram.
 *
 * Only allowlisted attributes are recorded. All telemetry work is wrapped in
 * a try/catch so a misbehaving exporter or SDK can never affect webhook
 * acceptance, error handling, or request latency.
 */
export function recordShopifyWebhookTelemetry(
  entry: ShopifyWebhookTelemetryEntry,
): void {
  try {
    const attributes = buildWebhookAttributes(entry);
    recordSpan(attributes, entry.ackMs);
    recordMetrics(attributes, entry.ackMs);
  } catch {
    // Telemetry is strictly best-effort; swallowing any failure keeps the
    // webhook ingest path isolated from observability problems.
  }
}

function buildWebhookAttributes(entry: ShopifyWebhookTelemetryEntry): Attributes {
  return {
    "shopify.webhook.topic": entry.topic,
    "shopify.webhook.event_type": entry.eventType ?? undefined,
    "shopify.webhook.outcome": entry.outcome,
    "shopify.webhook.queue": entry.queue ?? undefined,
    "shopify.webhook.status_code": entry.statusCode ?? undefined,
  };
}

function recordSpan(attributes: Attributes, ackMs: number): void {
  const span = tracer.startSpan(OTEL_WEBHOOK_SPAN_NAME, {
    attributes,
    // The event is recorded once processing finished; anchor the span start
    // so span duration matches the acknowledged processing time (ackMs).
    startTime: Date.now() - ackMs,
  });
  const outcome = attributes["shopify.webhook.outcome"];
  if (typeof outcome === "string" && !ACCEPTED_OUTCOMES.has(outcome)) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `shopify_webhook_${outcome}`,
    });
  }
  span.end();
}

function recordMetrics(attributes: Attributes, ackMs: number): void {
  ingress.add(1, attributes);
  duration.record(ackMs, attributes);
}
