import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import {
  buildDiscountSyncJob,
  hasReadDiscountsScope,
  isDiscountSyncEligible,
  markDiscountCatalogueSyncRequired,
  markDiscountCatalogueUnavailable,
  lockShopLifecycleRow,
} from "@/services/discounts/shopify-discount-lifecycle.service";
import { publishShopifyDiscountSyncJob } from "@/services/webhooks/shopify-webhook-queue.server";
import {
  recordShopifyWebhookAuthenticationFailure,
  recordShopifyWebhookReceived,
  recordShopifyWebhookRouteFailure,
  recordShopifyWebhookRouteOutcome,
} from "@/services/webhooks/shopify-webhook-observability.server";

const WEBHOOK_ROUTE = "/webhooks/app/scopes_update";

/** @param {{ request: Request }} args */
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

  const { payload, session, topic, shop, eventId } = authenticated;

  try {
    const current = payload.current.toString();
    const requestedAt = new Date();

    const syncRequest = await db.$transaction(async (transaction) => {
      const shopIdentity = await transaction.shop.findUnique({
        where: { domain: shop },
        select: { id: true },
      });
      if (!shopIdentity) return null;

      await lockShopLifecycleRow(transaction, shopIdentity.id);
      if (session) {
        await transaction.session.update({
          where: { id: session.id },
          data: { scope: current },
        });
      }

      const shopRecord = await transaction.shop.findUnique({
        where: { id: shopIdentity.id },
        select: {
          id: true,
          domain: true,
          status: true,
          settings: { select: { onboardingCompleted: true } },
          subscription: { select: { status: true } },
        },
      });
      if (!shopRecord) return null;

      const offlineSession = await transaction.session.findFirst({
        where: { shop: shopRecord.domain, isOnline: false },
        select: { scope: true },
        orderBy: { expires: "desc" },
      });
      const offlineScope = offlineSession?.scope ?? null;
      const eligible = isDiscountSyncEligible({
        shopStatus: shopRecord.status,
        onboardingCompleted: shopRecord.settings?.onboardingCompleted === true,
        subscriptionStatus: shopRecord.subscription?.status,
        sessionScope: offlineScope,
      });
      if (!offlineSession || !hasReadDiscountsScope(offlineScope)) {
        await markDiscountCatalogueUnavailable(transaction, shopRecord.id, requestedAt);
        return null;
      }
      if (!eligible) return null;

      await markDiscountCatalogueSyncRequired(transaction, shopRecord.id, requestedAt);
      return { shopId: shopRecord.id, shopDomain: shopRecord.domain };
    });

    if (syncRequest) {
      await publishShopifyDiscountSyncJob({
        event: buildDiscountSyncJob({
          shopId: syncRequest.shopId,
          shopDomain: syncRequest.shopDomain,
          reason: "SCOPES_UPDATED",
          requestedAt,
        }),
      });
    }

    recordShopifyWebhookRouteOutcome({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "APP_SCOPES_UPDATE",
      eventId: eventId ?? null,
      shopDomain: shop,
      shopId: syncRequest?.shopId ?? null,
      outcome: syncRequest
        ? "PROCESSED_APP_SCOPES_UPDATE_SYNC_REQUESTED"
        : "PROCESSED_APP_SCOPES_UPDATE",
      ackMs: Date.now() - startedAt,
    });

    return new Response();
  } catch (error) {
    recordShopifyWebhookRouteFailure({
      request,
      route: WEBHOOK_ROUTE,
      topic: topic ?? "APP_SCOPES_UPDATE",
      eventId: eventId ?? null,
      shopDomain: shop,
      error,
      ackMs: Date.now() - startedAt,
    });
    throw error;
  }
};
