import { authenticate } from "@/shopify.server";
import { shopifyOfflineCoordination } from "@/services/shopify-offline-coordination.server";
import {
  recordShopifyWebhookAuthenticationFailure,
  recordShopifyWebhookReceived,
  recordShopifyWebhookRouteFailure,
  recordShopifyWebhookRouteOutcome,
} from "@/services/webhooks/shopify-webhook-observability.server";

const WEBHOOK_ROUTE = "/webhooks/shop/redact";

// @ts-ignore
export const action = async ({ request }) => {
  const startedAt = Date.now();
  recordShopifyWebhookReceived({ request, route: WEBHOOK_ROUTE });

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

  const { shop, topic, eventId } = authenticated;

  try {
    await shopifyOfflineCoordination.withLifecycleLock(shop, async ({ transaction, shop: currentShop }) => {
      const storedDomain = currentShop?.domain ?? shop;
      // Session is keyed by shop domain rather than shopId, so it is not covered
      // by the Shop row's cascading deletes and must be cleaned up separately.
      await transaction.session.deleteMany({ where: { shop: storedDomain } });

      // Deleting Shop cascades to its related merchant data.
      await transaction.shop.deleteMany({
        where: currentShop ? { id: currentShop.id } : { domain: shop },
      });
    });

    recordShopifyWebhookRouteOutcome({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "SHOP_REDACT",
      eventId: eventId ?? null,
      shopDomain: shop,
      outcome: "PROCESSED_SHOP_REDACT",
      ackMs: Date.now() - startedAt,
    });

    return new Response();
  } catch (error) {
    recordShopifyWebhookRouteFailure({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "SHOP_REDACT",
      eventId: eventId ?? null,
      shopDomain: shop,
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }
};
