import type { Prisma } from "@prisma/client";
import {
  parseShopifyDiscountSyncJob,
  type ShopifyDiscountSyncJob,
} from "@modainteract/moda-interact-shared/shopify";

import db from "../../db.server";
import { publishShopifyDiscountSyncJob } from "../webhooks/shopify-webhook-queue.server";

export type DiscountSyncTrigger = ShopifyDiscountSyncJob["reason"];

export const DISCOUNT_WEBHOOK_TOPICS = new Set<ShopifyDiscountSyncJob["webhookTopic"]>([
  "discounts/create",
  "discounts/update",
  "discounts/delete",
  "discounts/redeemcode_added",
  "discounts/redeemcode_removed",
]);

export function hasReadDiscountsScope(scope: string | null | undefined): boolean {
  return scope?.split(",").some((entry) => entry.trim() === "read_discounts") ?? false;
}

export function isDiscountSyncEligible(input: {
  shopStatus: string;
  onboardingCompleted: boolean;
  subscriptionStatus: string | null | undefined;
  sessionScope: string | null | undefined;
}): boolean {
  return (
    input.shopStatus === "ACTIVE" &&
    input.onboardingCompleted &&
    (input.subscriptionStatus === "ACTIVE" || input.subscriptionStatus === "TRIALING") &&
    hasReadDiscountsScope(input.sessionScope)
  );
}

export async function getDiscountSyncEligibility(shopId: string) {
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      domain: true,
      status: true,
      settings: { select: { onboardingCompleted: true } },
      subscription: { select: { status: true } },
    },
  });
  if (!shop) return null;

  const session = await db.session.findFirst({
    where: { shop: shop.domain },
    select: { scope: true },
    orderBy: { expires: "desc" },
  });

  return {
    shop,
    eligible: isDiscountSyncEligible({
      shopStatus: shop.status,
      onboardingCompleted: shop.settings?.onboardingCompleted === true,
      subscriptionStatus: shop.subscription?.status,
      sessionScope: session?.scope,
    }),
  };
}

export async function markDiscountCatalogueSyncRequired(
  transaction: Prisma.TransactionClient,
  shopId: string,
  requestedAt: Date,
): Promise<void> {
  await transaction.shopifyDiscountCatalogue.upsert({
    where: { shopId },
    create: {
      shopId,
      status: "SYNC_REQUIRED",
      syncRequestedAt: requestedAt,
      unavailableAt: null,
    },
    update: {
      status: "SYNC_REQUIRED",
      syncRequestedAt: requestedAt,
      activeSyncToken: null,
      syncStartedAt: null,
      unavailableAt: null,
    },
  });
}

export async function markDiscountCatalogueUnavailable(
  transaction: Prisma.TransactionClient,
  shopId: string,
  unavailableAt: Date,
): Promise<void> {
  await transaction.shopifyDiscountCatalogue.updateMany({
    where: { shopId },
    data: {
      status: "UNAVAILABLE",
      activeSyncToken: null,
      syncStartedAt: null,
      unavailableAt,
    },
  });
  await transaction.shopifyDiscount.updateMany({
    where: { shopId },
    data: { isAvailable: false, unavailableAt },
  });
}

export function buildDiscountSyncJob(input: {
  shopId: string;
  shopDomain: string;
  reason: DiscountSyncTrigger;
  requestedAt: Date;
  deliveryId?: string | null;
  webhookTopic?: ShopifyDiscountSyncJob["webhookTopic"];
}): ShopifyDiscountSyncJob {
  return parseShopifyDiscountSyncJob({
    schemaVersion: 1,
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    reason: input.reason,
    requestedAt: input.requestedAt.toISOString(),
    deliveryId: input.deliveryId ?? null,
    webhookTopic: input.webhookTopic ?? null,
  });
}

export async function enqueueSubscriptionActivatedDiscountSyncBestEffort(
  shopId: string,
): Promise<void> {
  const requestedAt = new Date();
  try {
    const eligibility = await getDiscountSyncEligibility(shopId);
    if (!eligibility?.eligible) return;

    await db.$transaction(async (transaction) => {
      await markDiscountCatalogueSyncRequired(transaction, shopId, requestedAt);
    });

    await publishShopifyDiscountSyncJob({
      event: buildDiscountSyncJob({
        shopId,
        shopDomain: eligibility.shop.domain,
        reason: "SUBSCRIPTION_ACTIVATED",
        requestedAt,
      }),
    });
  } catch (error) {
    console.error("Failed to enqueue subscription-activated discount sync", {
      shopId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}