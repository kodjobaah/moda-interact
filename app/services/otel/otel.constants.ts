/**
 * OpenTelemetry constants for moda-interact.
 *
 * These values define the bounded Shopify webhook metric/span surface.
 */

/** Instrumentation scope name used for Shopify webhook traces. */
export const OTEL_WEBHOOK_TRACER_NAME = "moda-interact.shopify.webhooks";

/** Instrumentation scope name used for Shopify webhook metrics. */
export const OTEL_WEBHOOK_METER_NAME = "moda-interact.shopify.webhooks";

/** Span name recorded for each processed Shopify webhook delivery. */
export const OTEL_WEBHOOK_SPAN_NAME = "shopify.webhook.process";

/** Counter of Shopify webhook deliveries by processing outcome. */
export const OTEL_WEBHOOK_METRIC_INGRESS = "shopify.webhook.ingress";

/** Histogram of time (ms) taken to acknowledge a Shopify webhook delivery. */
export const OTEL_WEBHOOK_METRIC_DURATION = "shopify.webhook.duration";

/**
 * The only attribute keys allowed on Shopify webhook metrics and spans.
 *
 * PII/business data (shop domain, customer data, payload contents) is never
 * recorded; the `traceId` field on the queued recovery event already provides
 * correlation back to the originating delivery for any follow-up.
 */
export const OTEL_WEBHOOK_ATTRIBUTE_KEYS = [
  "shopify.webhook.topic",
  "shopify.webhook.event_type",
  "shopify.webhook.outcome",
  "shopify.webhook.queue",
  "shopify.webhook.status_code",
] as const;

export type ShopifyWebhookAttributeKey = (typeof OTEL_WEBHOOK_ATTRIBUTE_KEYS)[number];

/** OTel's "invalid" trace id; used to detect absent trace context. */
export const INVALID_TRACE_ID = "00000000000000000000000000000000";
