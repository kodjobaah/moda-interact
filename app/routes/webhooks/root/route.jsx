import { authenticate, apiKey } from "@/shopify.server";
import { ingestShopifyWebhook, isShopifyWhatsAppConsentTopic } from "@/services/webhooks/shopify-webhook-ingress.service";
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
  // Shopify webhook `customer_id` can exceed JS safe-integer precision.
  // Only for this topic, retain the raw request while the SDK authenticates
  // its own clone. All other high-volume topics keep their original path.
  const consentRawRequest = isShopifyWhatsAppConsentTopic(
    request.headers.get("X-Shopify-Topic") ?? "",
  ) ? request.clone() : null;

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

  // Fail closed if an authenticated consent topic was not advertised in the
  // request header and therefore its exact numeric customer ID is unavailable.
  try {
    const authenticatedConsentRawBody = isShopifyWhatsAppConsentTopic(topic)
      ? await consentRawRequest?.text() ?? null
      : null;

    return await ingestShopifyWebhook({
      request,
      authenticatedConsentRawBody,
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
