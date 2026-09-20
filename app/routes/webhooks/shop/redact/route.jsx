import { authenticate } from "@/shopify.server";
import db from "@/db.server";
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
    // Session is keyed by shop domain rather than shopId, so it isn't covered
    // by the Shop row's cascading deletes and must be cleaned up separately.
    await db.session.deleteMany({ where: { shop } });

    // Deleting Shop cascades to ShopSettings, ShopBrand, Subscription,
    // UsageEvent, BillingPeriod, Customer, CustomerPhone, CheckoutRecovery,
    // Conversation and ConversationMessage.
    await db.shop.deleteMany({ where: { domain: shop } });

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
