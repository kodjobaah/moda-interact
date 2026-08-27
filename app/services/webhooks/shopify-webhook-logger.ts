export type ShopifyWebhookLogEntry = {
  receiptId: string | null;
  deliveryId: string;
  eventId: string | null;
  providerTopic: string;
  internalEventType: string | null;
  shopId: string | null;
  shopDomain: string;
  disposition: string;
  duplicate: boolean;
  transactionMs: number;
  ackMs: number;
};

export function logShopifyWebhookOutcome(entry: ShopifyWebhookLogEntry): void {
  console.info(
    "shopify_webhook",
    JSON.stringify({
      receiptId: entry.receiptId,
      deliveryId: entry.deliveryId,
      eventId: entry.eventId,
      providerTopic: entry.providerTopic,
      internalEventType: entry.internalEventType,
      shopId: entry.shopId,
      shopDomain: entry.shopDomain,
      disposition: entry.disposition,
      duplicate: entry.duplicate,
      transactionMs: entry.transactionMs,
      ackMs: entry.ackMs,
    }),
  );
}
