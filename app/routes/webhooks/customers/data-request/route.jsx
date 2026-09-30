import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import {
  recordShopifyWebhookAuthenticationFailure,
  recordShopifyWebhookReceived,
  recordShopifyWebhookRouteFailure,
  recordShopifyWebhookRouteOutcome,
} from "@/services/webhooks/shopify-webhook-observability.server";

const WEBHOOK_ROUTE = "/webhooks/customers/data_request";

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
    // No automated export pipeline yet. Resolve the shop so the operational
    // acknowledgement can be correlated without emitting customer payload/PII.
    const shopRecord = await db.shop.findUnique({ where: { domain: shop } });

    recordShopifyWebhookRouteOutcome({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "CUSTOMERS_DATA_REQUEST",
      eventId: eventId ?? null,
      shopDomain: shop,
      shopId: shopRecord?.id ?? null,
      outcome: "PROCESSED_CUSTOMERS_DATA_REQUEST",
      ackMs: Date.now() - startedAt,
    });

    return new Response();
  } catch (error) {
    recordShopifyWebhookRouteFailure({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "CUSTOMERS_DATA_REQUEST",
      eventId: eventId ?? null,
      shopDomain: shop,
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }
};
