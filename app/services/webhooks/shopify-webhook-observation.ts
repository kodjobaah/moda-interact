/**
 * Structured observation of a Shopify webhook processing outcome.
 *
 * This type-only module defines the PII-safe contract shared by the
 * observability adapter (shared structured logger) and the Shopify-specific
 * OpenTelemetry recorder. It deliberately contains no logger or telemetry
 * implementation: emitting an observation is owned by
 * `shopify-webhook-observability.server.ts`.
 *
 * Only allowlisted business-safe dimensions are carried. Customer/PII data
 * (email, phone, address, name) and payload contents are never recorded.
 */
export type ShopifyWebhookObservation = {
  topic: string;
  deliveryId: string;
  eventId: string | null;
  queue: string | null;
  jobId: string | null;
  outcome: string;
  shopId: string | null;
  shopDomain: string;
  ackMs: number;
};
