import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import {
  buildDiscountSyncJob,
  hasReadDiscountsScope,
  isDiscountSyncEligible,
  markDiscountCatalogueSyncRequired,
  markDiscountCatalogueUnavailable,
} from "@/services/discounts/shopify-discount-lifecycle.service";
import { publishShopifyDiscountSyncJob } from "@/services/webhooks/shopify-webhook-queue.server";

/** @param {{ request: Request }} args */
export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current.toString();
  const requestedAt = new Date();

  const syncRequest = await db.$transaction(async (transaction) => {
    if (session) {
      await transaction.session.update({
        where: { id: session.id },
        data: { scope: current },
      });
    }

    const shopRecord = await transaction.shop.findUnique({
      where: { domain: shop },
      select: {
        id: true,
        domain: true,
        status: true,
        settings: { select: { onboardingCompleted: true } },
        subscription: { select: { status: true } },
      },
    });
    if (!shopRecord) return null;

    const eligible = isDiscountSyncEligible({
      shopStatus: shopRecord.status,
      onboardingCompleted: shopRecord.settings?.onboardingCompleted === true,
      subscriptionStatus: shopRecord.subscription?.status,
      sessionScope: current,
    });
    if (!hasReadDiscountsScope(current)) {
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

  return new Response();
};
