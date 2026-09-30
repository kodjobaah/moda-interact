import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import {
  recordShopifyWebhookAuthenticationFailure,
  recordShopifyWebhookReceived,
  recordShopifyWebhookRouteFailure,
  recordShopifyWebhookRouteOutcome,
} from "@/services/webhooks/shopify-webhook-observability.server";

const WEBHOOK_ROUTE = "/webhooks/customers/redact";

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

  const { shop, topic, payload, eventId } = authenticated;

  try {
    const shopifyCustomerId = payload.customer?.id
      ? String(payload.customer.id)
      : null;

    if (!shopifyCustomerId) {
      recordShopifyWebhookRouteOutcome({
        request,
        route: WEBHOOK_ROUTE,
        topic: topic ?? "CUSTOMERS_REDACT",
        eventId: eventId ?? null,
        shopDomain: shop,
        outcome: "IGNORED_MISSING_CUSTOMER_ID",
        ackMs: Date.now() - startedAt,
      });
      return new Response();
    }

    const shopRecord = await db.shop.findUnique({ where: { domain: shop } });

    if (!shopRecord) {
      recordShopifyWebhookRouteOutcome({
        request,
        route: WEBHOOK_ROUTE,
        topic: topic ?? "CUSTOMERS_REDACT",
        eventId: eventId ?? null,
        shopDomain: shop,
        outcome: "IGNORED_UNKNOWN_SHOP",
        ackMs: Date.now() - startedAt,
      });
      return new Response();
    }

    const customer = await db.customer.findUnique({
      where: {
        shopId_shopifyCustomerId: {
          shopId: shopRecord.id,
          shopifyCustomerId,
        },
      },
    });

    if (!customer) {
      recordShopifyWebhookRouteOutcome({
        request,
        route: WEBHOOK_ROUTE,
        topic: topic ?? "CUSTOMERS_REDACT",
        eventId: eventId ?? null,
        shopDomain: shop,
        shopId: shopRecord.id,
        outcome: "IGNORED_UNKNOWN_CUSTOMER",
        ackMs: Date.now() - startedAt,
      });
      return new Response();
    }

    // CheckoutRecovery keeps a required-in-practice link to Customer for recovery
    // and billing history, so we anonymise rather than hard-delete the row.
    await db.customer.update({
      where: { id: customer.id },
      data: {
        email: null,
        phone: null,
        firstName: null,
        lastName: null,
      },
    });

    await db.customerPhone.updateMany({
      where: { customerId: customer.id, endedAt: null },
      data: { endedAt: new Date() },
    });

    recordShopifyWebhookRouteOutcome({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "CUSTOMERS_REDACT",
      eventId: eventId ?? null,
      shopDomain: shop,
      shopId: shopRecord.id,
      outcome: "PROCESSED_CUSTOMERS_REDACT",
      ackMs: Date.now() - startedAt,
    });

    return new Response();
  } catch (error) {
    recordShopifyWebhookRouteFailure({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "CUSTOMERS_REDACT",
      eventId: eventId ?? null,
      shopDomain: shop,
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }
};
