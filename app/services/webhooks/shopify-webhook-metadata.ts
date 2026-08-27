export class ShopifyWebhookMetadataError extends Error {
  code: "MISSING_DELIVERY_ID" | "CONFLICTING_DELIVERY_ID";

  constructor(
    message: string,
    code: "MISSING_DELIVERY_ID" | "CONFLICTING_DELIVERY_ID",
  ) {
    super(message);
    this.name = "ShopifyWebhookMetadataError";
    this.code = code;
  }
}

const DELIVERY_ID_HEADER = "X-Shopify-Webhook-Id";
const DELIVERY_ID_ALIAS_HEADER = "Webhook-Id";
const EVENT_ID_HEADER = "X-Shopify-Event-Id";
const API_VERSION_HEADER = "X-Shopify-API-Version";
const TRIGGERED_AT_HEADER = "X-Shopify-Triggered-At";
const NAME_HEADER = "X-Shopify-Name";

export type ShopifyWebhookMetadata = {
  appKey: string;
  deliveryId: string;
  eventId: string | null;
  shopDomain: string;
  providerTopic: string;
  apiVersion: string | null;
  triggeredAt: Date | null;
  triggeredAtRaw: string | null;
  subscriptionName: string | null;
  receivedAt: Date;
};

export type ShopifyWebhookAuthContext = {
  appKey: string;
  shop: string;
  topic: string;
  apiVersion?: string | null;
  eventId?: string | null;
  triggeredAt?: string | null;
  name?: string | null;
};

export function parseShopifyWebhookMetadata(
  headers: Headers,
  auth: ShopifyWebhookAuthContext,
): ShopifyWebhookMetadata {
  const primaryDeliveryId = headers.get(DELIVERY_ID_HEADER);
  const aliasDeliveryId = headers.get(DELIVERY_ID_ALIAS_HEADER);

  if (
    primaryDeliveryId &&
    aliasDeliveryId &&
    primaryDeliveryId !== aliasDeliveryId
  ) {
    throw new ShopifyWebhookMetadataError(
      "Conflicting delivery ID headers",
      "CONFLICTING_DELIVERY_ID",
    );
  }

  const deliveryId = primaryDeliveryId ?? aliasDeliveryId;

  if (!deliveryId) {
    throw new ShopifyWebhookMetadataError(
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
    providerTopic: auth.topic,
    apiVersion: headers.get(API_VERSION_HEADER) ?? auth.apiVersion ?? null,
    triggeredAt: parseDate(triggeredAtRaw),
    triggeredAtRaw,
    subscriptionName: headers.get(NAME_HEADER) ?? auth.name ?? null,
    receivedAt: new Date(),
  };
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
