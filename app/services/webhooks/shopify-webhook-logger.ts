export type ShopifyWebhookLogEntry = {
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

export function logShopifyWebhookOutcome(entry: ShopifyWebhookLogEntry): void {
  console.info(
    "shopify_webhook",
    JSON.stringify({
      topic: entry.topic,
      deliveryId: entry.deliveryId,
      eventId: entry.eventId,
      queue: entry.queue,
      jobId: entry.jobId,
      outcome: entry.outcome,
      shopId: entry.shopId,
      shopDomain: entry.shopDomain,
      ackMs: entry.ackMs,
    }),
  );
}
