export type ShopifyWebhookLogEntry = {
  receiptId: string | null;
  deliveryId: string;
  eventId: string | null;
  providerTopic: string;
  eventType: string | null;
  destination: string | null;
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
      eventType: entry.eventType,
      destination: entry.destination,
      shopId: entry.shopId,
      shopDomain: entry.shopDomain,
      disposition: entry.disposition,
      duplicate: entry.duplicate,
      transactionMs: entry.transactionMs,
      ackMs: entry.ackMs,
    }),
  );
}
