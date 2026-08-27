/**
 * Shopify webhook ingress application service.
 *
 * `app/routes/webhooks.jsx` is a thin HTTP adapter: it calls
 * `authenticate.webhook` and hands the authenticated context to this
 * service, which parses/validates metadata, classifies and normalizes the
 * payload, and dispatches according to `WEBHOOK_DISPATCH_MODE`.
 *
 * Dispatch implementations are loaded dynamically so that outbox mode never
 * loads the Redis/BullMQ-dependent legacy module.
 */
import process from "node:process";
import { parseWebhookMetadata, WebhookMetadataError } from "./webhook-metadata";
import { logWebhookOutcome } from "./webhook-logger.server";

/**
 * @returns {"legacy" | "outbox"}
 */
export function getWebhookDispatchMode() {
  return process.env.WEBHOOK_DISPATCH_MODE === "outbox" ? "outbox" : "legacy";
}

/**
 * @param {{
 *   request: Request,
 *   appKey: string,
 *   shop: string,
 *   topic: string,
 *   payload: Record<string, any>,
 *   apiVersion?: string | null,
 *   eventId?: string | null,
 *   triggeredAt?: string | null,
 *   name?: string | null,
 * }} input
 */
export async function ingestShopifyWebhook(input) {
  const startedAt = Date.now();

  let metadata;
  try {
    metadata = parseWebhookMetadata(input.request.headers, input);
  } catch (error) {
    if (error instanceof WebhookMetadataError) {
      logWebhookOutcome({
        deliveryId: "unknown",
        topic: input.topic,
        shopDomain: input.shop,
        disposition: `REJECTED_${error.code}`,
        durationMs: Date.now() - startedAt,
      });
      return new Response(null, { status: 400 });
    }
    throw error;
  }

  if (getWebhookDispatchMode() === "outbox") {
    const { dispatchOutbox } = await import("./dispatch/outbox-dispatch.server");
    return dispatchOutbox(metadata, input.payload, startedAt);
  }

  const { dispatchLegacy } = await import("./dispatch/legacy-dispatch.server");
  return dispatchLegacy(metadata, input.payload, startedAt);
}
