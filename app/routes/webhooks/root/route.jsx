import { authenticate, apiKey } from "@/shopify.server";
import { ingestShopifyWebhook } from "@/services/webhooks/shopify-webhook-ingress.service";
import {
  recordShopifyWebhookAuthenticationFailure,
  recordShopifyWebhookReceived,
  recordShopifyWebhookRouteFailure,
} from "@/services/webhooks/shopify-webhook-observability.server";

const WEBHOOK_ROUTE = "/webhooks";

// @ts-ignore
export const action = async ({ request }) => {
  const startedAt = Date.now();
  recordShopifyWebhookReceived({ request, route: WEBHOOK_ROUTE });

  if (!apiKey) {
    const error = new Error("SHOPIFY_API_KEY is not configured");
    recordShopifyWebhookRouteFailure({
      request,
      route: WEBHOOK_ROUTE,
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }

  // Copy to a local const: narrowing on an imported binding does not persist
  // into a closure, but narrowing on a local const does.
  const shopifyApiKey = apiKey;

  // Authenticate before trusting any payload or header metadata. A thrown
  // HMAC/authentication failure here must propagate untouched.
  let authenticated;
  try {
    authenticated = await authenticate.webhook(request);
  } catch (error) {
    recordShopifyWebhookAuthenticationFailure({
      request,
      route: WEBHOOK_ROUTE,
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }

  const { topic, shop, payload, apiVersion, eventId, triggeredAt, name } =
    authenticated;

  try {
    return await ingestShopifyWebhook({
      request,
      appKey: shopifyApiKey,
      shop,
      topic,
      payload,
      apiVersion,
      eventId,
      triggeredAt,
      name,
    });
  } catch (error) {
    recordShopifyWebhookRouteFailure({
      request,
      route: WEBHOOK_ROUTE,
      topic,
      eventId: eventId ?? null,
      shopDomain: shop,
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }
};
