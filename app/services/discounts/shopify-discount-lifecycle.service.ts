import { Prisma } from "@prisma/client";
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

export async function lockShopLifecycleRow(
  transaction: Prisma.TransactionClient,
  shopId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${shopId} FOR UPDATE`,
  );
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
  await transaction.shopifyDiscountCatalogue.upsert({
    where: { shopId },
    create: {
      shopId,
      status: "UNAVAILABLE",
      activeSyncToken: null,
      syncStartedAt: null,
      unavailableAt,
    },
    update: {
      status: "UNAVAILABLE",
      activeSyncToken: null,
      syncStartedAt: null,
      unavailableAt,
    },
  });
  await transaction.shopifyDiscount.updateMany({
    where: { shopId },
    data: { isAvailable: false },
  });
  await transaction.shopifyDiscount.updateMany({
    where: { shopId, unavailableAt: null },
    data: { unavailableAt },
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
    const syncRequest = await db.$transaction(async (transaction: Prisma.TransactionClient) => {
      const shop = await transaction.shop.findUnique({
        where: { id: shopId },
        select: { id: true },
      });
      if (!shop) return null;

      await lockShopLifecycleRow(transaction, shop.id);
      const authoritativeShop = await transaction.shop.findUnique({
        where: { id: shop.id },
        select: {
          id: true,
          domain: true,
          status: true,
          settings: { select: { onboardingCompleted: true } },
          subscription: { select: { status: true } },
        },
      });
      if (!authoritativeShop) return null;

      const offlineSession = await transaction.session.findFirst({
        where: { shop: authoritativeShop.domain, isOnline: false },
        select: { scope: true },
        orderBy: { expires: "desc" },
      });
      const eligible = isDiscountSyncEligible({
        shopStatus: authoritativeShop.status,
        onboardingCompleted: authoritativeShop.settings?.onboardingCompleted === true,
        subscriptionStatus: authoritativeShop.subscription?.status,
        sessionScope: offlineSession?.scope,
      });
      if (!eligible) return null;

      await markDiscountCatalogueSyncRequired(transaction, shopId, requestedAt);
      return { shopId: authoritativeShop.id, shopDomain: authoritativeShop.domain };
    });

    if (!syncRequest) return;
    await publishShopifyDiscountSyncJob({
      event: buildDiscountSyncJob({
        shopId,
        shopDomain: syncRequest.shopDomain,
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