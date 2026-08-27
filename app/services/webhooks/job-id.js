import crypto from "node:crypto";

/**
 * Deterministic, BullMQ-safe job ID shared by legacy direct-publish mode and
 * outbox mode so both dedupe against the exact same key. Must not contain
 * timestamps or colons.
 *
 * @param {string} appKey
 * @param {string} deliveryId
 */
export function buildWebhookJobId(appKey, deliveryId) {
  const hash = crypto
    .createHash("sha256")
    .update(`${appKey}:${deliveryId}`)
    .digest("hex");

  return `shopify-${hash}`;
}
