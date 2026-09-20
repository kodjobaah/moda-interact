import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import { shopService } from "@/services/shop/shop.service";
import {
  recordShopifyWebhookAuthenticationFailure,
  recordShopifyWebhookReceived,
  recordShopifyWebhookRouteFailure,
  recordShopifyWebhookRouteOutcome,
} from "@/services/webhooks/shopify-webhook-observability.server";

const WEBHOOK_ROUTE = "/webhooks/app/uninstalled";

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

  const { shop, session, triggeredAt, topic, eventId } = authenticated;

  try {
    const eventTime = triggeredAt ? new Date(triggeredAt) : new Date();
    await shopService.markUninstalled(
      shop,
      Number.isNaN(eventTime.getTime()) ? new Date() : eventTime,
    );

    // Webhook requests can trigger multiple times and after an app has already been uninstalled.
    // If this webhook already ran, the session may have been deleted previously.
    if (session) {
      await db.session.deleteMany({ where: { shop } });
    }

    recordShopifyWebhookRouteOutcome({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "APP_UNINSTALLED",
      eventId: eventId ?? null,
      shopDomain: shop,
      outcome: "PROCESSED_APP_UNINSTALLED",
      ackMs: Date.now() - startedAt,
    });

    return new Response();
  } catch (error) {
    recordShopifyWebhookRouteFailure({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "APP_UNINSTALLED",
      eventId: eventId ?? null,
      shopDomain: shop,
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }
};
