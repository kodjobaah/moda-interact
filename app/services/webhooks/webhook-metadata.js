/**
 * Strict parsing of the authenticated Shopify webhook metadata this app
 * persists alongside a receipt. Nothing here trusts the request until after
 * `authenticate.webhook` has verified it; this module only extracts and
 * validates headers/context, it never re-verifies HMAC and never reads or
 * stores HMAC values.
 */

export class WebhookMetadataError extends Error {
  /**
   * @param {string} message
   * @param {"MISSING_DELIVERY_ID" | "CONFLICTING_DELIVERY_ID"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "WebhookMetadataError";
    this.code = code;
  }
}

const DELIVERY_ID_HEADER = "X-Shopify-Webhook-Id";
const DELIVERY_ID_ALIAS_HEADER = "Webhook-Id";
const EVENT_ID_HEADER = "X-Shopify-Event-Id";
const API_VERSION_HEADER = "X-Shopify-API-Version";
const TRIGGERED_AT_HEADER = "X-Shopify-Triggered-At";
const NAME_HEADER = "X-Shopify-Name";

/**
 * @typedef {{
 *   appKey: string,
 *   deliveryId: string,
 *   eventId: string | null,
 *   shopDomain: string,
 *   topic: string,
 *   apiVersion: string | null,
 *   triggeredAt: Date | null,
 *   triggeredAtRaw: string | null,
 *   subscriptionName: string | null,
 *   receivedAt: Date,
 * }} ShopifyWebhookMetadata
 */

/**
 * @param {Headers} headers
 * @param {{
 *   appKey: string,
 *   shop: string,
 *   topic: string,
 *   apiVersion?: string | null,
 *   eventId?: string | null,
 *   triggeredAt?: string | null,
 *   name?: string | null,
 * }} auth Authenticated context returned by `authenticate.webhook`.
 * @returns {ShopifyWebhookMetadata}
 */
export function parseWebhookMetadata(headers, auth) {
  const primaryDeliveryId = headers.get(DELIVERY_ID_HEADER);
  const aliasDeliveryId = headers.get(DELIVERY_ID_ALIAS_HEADER);

  if (
    primaryDeliveryId &&
    aliasDeliveryId &&
    primaryDeliveryId !== aliasDeliveryId
  ) {
    throw new WebhookMetadataError(
      "Conflicting delivery ID headers",
      "CONFLICTING_DELIVERY_ID",
    );
  }

  const deliveryId = primaryDeliveryId ?? aliasDeliveryId;

  if (!deliveryId) {
    throw new WebhookMetadataError(
      "Missing delivery ID header",
      "MISSING_DELIVERY_ID",
    );
  }

  const triggeredAtRaw =
    headers.get(TRIGGERED_AT_HEADER) ?? auth.triggeredAt ?? null;

  return {
    appKey: auth.appKey,
    deliveryId,

    eventId: headers.get(EVENT_ID_HEADER) ?? auth.eventId ?? null,

    shopDomain: auth.shop,
    topic: auth.topic,

    apiVersion: headers.get(API_VERSION_HEADER) ?? auth.apiVersion ?? null,

    triggeredAt: parseDate(triggeredAtRaw),
    triggeredAtRaw,

    subscriptionName: headers.get(NAME_HEADER) ?? auth.name ?? null,

    receivedAt: new Date(),
  };
}

/**
 * @param {string | null} value
 */
function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
