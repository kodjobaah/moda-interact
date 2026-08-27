import { authenticate, apiKey } from "../shopify.server";
import { ingestShopifyWebhook } from "../services/webhooks/webhook-ingress.service";

// @ts-ignore
export const action = async ({ request }) => {
  if (!apiKey) {
    throw new Error("SHOPIFY_API_KEY is not configured");
  }

  // Copy to a local const: narrowing on an imported binding does not persist
  // into a closure, but narrowing on a local const does.
  const shopifyApiKey = apiKey;

  // Authenticate before trusting any payload or header metadata. A thrown
  // HMAC/authentication failure here must propagate untouched.
  const { topic, shop, payload, apiVersion, eventId, triggeredAt, name } =
    await authenticate.webhook(request);

  return ingestShopifyWebhook({
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
};
