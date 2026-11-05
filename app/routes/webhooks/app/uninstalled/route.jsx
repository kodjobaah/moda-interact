import { authenticate } from "@/shopify.server";
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

  const { shop, triggeredAt, topic, eventId } = authenticated;

  try {
    const eventTime = triggeredAt ? new Date(triggeredAt) : new Date();
    const result = await shopService.markUninstalled(
      shop,
      Number.isNaN(eventTime.getTime()) ? new Date() : eventTime,
    );
    const outcome = result.kind === "UNINSTALLED"
      ? "PROCESSED_APP_UNINSTALLED"
      : result.kind === "ALREADY_UNINSTALLED"
        ? "DUPLICATE_APP_UNINSTALLED"
        : "APP_UNINSTALLED_SHOP_NOT_FOUND";

    recordShopifyWebhookRouteOutcome({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "APP_UNINSTALLED",
      eventId: eventId ?? null,
      shopDomain: shop,
      outcome,
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
      operation: "mark_uninstalled",
      stage: "transaction",
      origin: "database",
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }
};
