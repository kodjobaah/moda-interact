export type ShopifyWebhookInternalEventType =
  | "checkout.observed"
  | "order.completed";

export type ShopifyWebhookJobV1<T> = {
  schemaVersion: 1;
  receiptId: string;
  deliveryId: string;
  eventId: string | null;
  source: "shopify";
  eventType: ShopifyWebhookInternalEventType;
  providerTopic: string;
  tenant: {
    shopId: string;
    shopDomain: string;
  };
  occurredAt: string | null;
  receivedAt: string;
  traceId: string;
  orderingKey: string;
  payload: T;
};
