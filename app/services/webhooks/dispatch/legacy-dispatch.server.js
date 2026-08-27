/**
 * Legacy direct-publish dispatch: preserves the pre-outbox behaviour of
 * publishing straight to BullMQ, but with the deterministic job ID so BullMQ
 * dedupe actually works (previous job IDs embedded `Date.now()`, defeating
 * dedupe entirely).
 */
import { normaliseCheckoutCreated } from "../../../domain/checkout-events";
import { normaliseOrderCreated } from "../../../domain/order-events";
import { getCheckoutQueue } from "../../../lib/queues/checkout.queue";
import { ordersQueue } from "../../../lib/queues/order.server";
import { classifyTopic } from "../webhook-classification";
import { resolveCheckoutDelayMs } from "../checkout-delay.server";
import { buildWebhookJobId } from "../job-id";
import { logWebhookOutcome } from "../webhook-logger.server";

/**
 * @param {import("../webhook-metadata").ShopifyWebhookMetadata} metadata
 * @param {Record<string, any>} payload
 * @param {number} startedAt
 */
export async function dispatchLegacy(metadata, payload, startedAt) {
  const classification = classifyTopic(metadata.topic);
  const jobId = buildWebhookJobId(metadata.appKey, metadata.deliveryId);

  if (classification.kind === "checkout") {
    const checkout = normaliseCheckoutCreated(metadata.shopDomain, payload);

    if (!checkout.checkoutToken) {
      logWebhookOutcome({
        deliveryId: metadata.deliveryId,
        eventId: metadata.eventId,
        topic: metadata.topic,
        shopDomain: metadata.shopDomain,
        disposition: "REJECTED",
        durationMs: Date.now() - startedAt,
      });
      return new Response(null, { status: 200 });
    }

    const delayMs = await resolveCheckoutDelayMs(metadata.shopDomain);
    const queue = getCheckoutQueue();

    await queue.add("checkout-created", checkout, {
      jobId,
      delay: delayMs,
    });

    logWebhookOutcome({
      deliveryId: metadata.deliveryId,
      eventId: metadata.eventId,
      topic: metadata.topic,
      shopDomain: metadata.shopDomain,
      disposition: "ACCEPTED",
      durationMs: Date.now() - startedAt,
    });
    return new Response(null, { status: 200 });
  }

  if (classification.kind === "order") {
    const order = normaliseOrderCreated(metadata.shopDomain, payload);

    if (!order.orderId) {
      logWebhookOutcome({
        deliveryId: metadata.deliveryId,
        eventId: metadata.eventId,
        topic: metadata.topic,
        shopDomain: metadata.shopDomain,
        disposition: "REJECTED",
        durationMs: Date.now() - startedAt,
      });
      return new Response(null, { status: 200 });
    }

    await ordersQueue.add("order-completed", order, { jobId });

    logWebhookOutcome({
      deliveryId: metadata.deliveryId,
      eventId: metadata.eventId,
      topic: metadata.topic,
      shopDomain: metadata.shopDomain,
      disposition: "ACCEPTED",
      durationMs: Date.now() - startedAt,
    });
    return new Response(null, { status: 200 });
  }

  logWebhookOutcome({
    deliveryId: metadata.deliveryId,
    eventId: metadata.eventId,
    topic: metadata.topic,
    shopDomain: metadata.shopDomain,
    disposition: "IGNORED",
    durationMs: Date.now() - startedAt,
  });
  return new Response(null, { status: 200 });
}
