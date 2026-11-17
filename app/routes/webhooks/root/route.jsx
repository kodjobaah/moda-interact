import { createHash } from "node:crypto";
import { authenticate, apiKey } from "@/shopify.server";
import { ingestShopifyWebhook, isShopifyWhatsAppConsentTopic } from "@/services/webhooks/shopify-webhook-ingress.service";
import {
  recordShopifyWebhookAuthenticationFailure,
  recordShopifyWebhookReceived,
  recordShopifyWebhookRouteFailure,
} from "@/services/webhooks/shopify-webhook-observability.server";

const WEBHOOK_ROUTE = "/webhooks";

// Temporary, opt-in ARCH-077/S001 diagnostics for authenticated cart/checkout
// webhooks. Never log raw tokens, private cart keys, or webhook payloads.
function logS001CartCheckoutTokenFingerprints(topic, payload) {
  if (process.env.ARCH077_S001_DIAGNOSTICS !== "1" ||
      !/^(?:CARTS|CHECKOUTS)[_/]/i.test(String(topic))) return;

  try {
    const hash = (token) => typeof token === "string" && token.length > 0
      ? createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16)
      : null;
    // Ajax cart tokens may include ?key=..., while webhook tokens may not.
    const base = (token) => typeof token === "string" ? token.split("?")[0] : null;
    // Cart webhooks may expose attributes as an object, while checkout
    // webhooks typically expose note_attributes as name/value entries.
    // Read only our diagnostic marker; never print its raw value.
    const readMarker = (attributes) => Array.isArray(attributes)
      ? attributes.find((item) => item?.name === "moda_s001_probe")?.value
      : attributes && typeof attributes === "object"
        ? attributes.moda_s001_probe
        : null;
    const marker = readMarker(payload?.note_attributes) ??
      readMarker(payload?.attributes);
    console.info("arch077.s001.webhook", {
      topic: String(topic),
      tokenHash: hash(payload?.token),
      tokenWithoutKeyHash: hash(base(payload?.token)),
      checkoutCartTokenHash: hash(payload?.cart_token),
      checkoutCartTokenWithoutKeyHash: hash(base(payload?.cart_token)),
      correlationMarkerPresent: typeof marker === "string" && marker.length > 0,
      correlationMarkerHash: hash(marker),
    });
  } catch (error) {
    // Optional diagnostics must never interrupt webhook processing.
    console.warn("arch077.s001.diagnostics_failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

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

  // Only after Shopify has authenticated this webhook. Disabled by default.
  logS001CartCheckoutTokenFingerprints(topic, payload);

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
      // Typed publication failures are owned by ingress; unexpected DB failures propagate here.
      origin: error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^P\d{4}$/.test(error.code)
        ? "database" : "internal",
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }
};
