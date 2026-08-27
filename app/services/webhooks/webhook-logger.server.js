/**
 * Structured, PII-safe webhook logging. Only ever logs correlation
 * identifiers and outcome metadata — never raw payloads, headers, or HMAC
 * values.
 *
 * @param {{
 *   receiptId?: string | null,
 *   deliveryId: string,
 *   eventId?: string | null,
 *   topic: string,
 *   shopId?: string | null,
 *   shopDomain: string,
 *   disposition: string,
 *   durationMs: number,
 *   duplicate?: boolean,
 * }} entry
 */
export function logWebhookOutcome(entry) {
  console.log(
    "shopify_webhook",
    JSON.stringify({
      receiptId: entry.receiptId ?? null,
      deliveryId: entry.deliveryId,
      eventId: entry.eventId ?? null,
      topic: entry.topic,
      shopId: entry.shopId ?? null,
      shopDomain: entry.shopDomain,
      disposition: entry.disposition,
      durationMs: entry.durationMs,
      duplicate: Boolean(entry.duplicate),
    }),
  );
}
