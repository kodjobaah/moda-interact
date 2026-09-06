import { randomUUID } from "node:crypto";

import type {
  Subscription,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  PLATFORM_SUPPORT_LANGUAGE_TAG,
  requiresMerchantTranslation,
} from "@modainteract/moda-interact-shared/merchant-communications";



import type {
  BillingProvider,
} from "./billing.types";

import {
  ShopifyBillingProvider,
} from "./providers/shopify-billing.provider";
import prisma from "../../db.server";
import {
  enqueueTranslationBestEffort,
  trustedSupportLanguageTag,
} from "../merchant-support/merchant-support.service";

type TranslationDispatch = (translationId: string) => Promise<void>;

type SubscriptionLifecycle = {
  planHandle: string;
  provider: string;
  lifecycleIdentity: string | null;
};

type SubscriptionIdentityFacts = {
  planHandle: string;
  provider: string;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
};

const MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY =
  "Unable to derive a durable subscription lifecycle identity.";

function deriveLifecycleIdentity(subscription: SubscriptionIdentityFacts): string | null {
  if (subscription.providerSubscriptionId?.trim()) {
    return `provider:${subscription.providerSubscriptionId.trim()}`;
  }

  const cycleFacts = [
    subscription.currentPeriodStart?.toISOString(),
    subscription.currentPeriodEnd?.toISOString(),
    subscription.trialEndsAt?.toISOString(),
  ];
  if (cycleFacts.every((fact) => !fact)) return null;
  return `cycle:${subscription.planHandle}:${cycleFacts.map((fact) => fact ?? "none").join(":")}`;
}

export function renderSubscriptionEndedMessage(planHandle: string): string {
  return `Your ${planHandle} subscription has ended and is no longer active.`;
}

async function persistSubscriptionEndedNotification(
  database: typeof prisma,
  shopId: string,
  lifecycle: SubscriptionLifecycle,
): Promise<string | null> {
  return database.$transaction(async (transaction) => {
    const settings = await transaction.$queryRaw<[{ defaultLanguageTag: string | null }]>(Prisma.sql`
      SELECT "defaultLanguageTag"
      FROM "shopify"."ShopSettings"
      WHERE "shopId" = ${shopId}
    `);
    const configuredLanguageTag = trustedSupportLanguageTag(
      settings[0]?.defaultLanguageTag,
    );
    const now = new Date();
    if (!lifecycle.lifecycleIdentity) {
      throw new Error(MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY);
    }
    const sourceKey = [
      "subscription-ended:v1",
      shopId,
      lifecycle.provider,
      lifecycle.lifecycleIdentity,
    ].map((part) => encodeURIComponent(part)).join(":");
    const existing = await transaction.$queryRaw<[
      { id: string; displayLanguageTag: string | null } | undefined
    ]>(Prisma.sql`
      SELECT "id", "displayLanguageTag"
      FROM "support"."MerchantSupportMessage"
      WHERE "sourceKey" = ${sourceKey}
    `);
    let messageId = existing[0]?.id;
    let messageWasInserted = false;
    const displayLanguageTag = existing[0]?.displayLanguageTag ?? configuredLanguageTag;
    const needsTranslation = requiresMerchantTranslation(
      PLATFORM_SUPPORT_LANGUAGE_TAG,
      displayLanguageTag,
    );

    const thread = await transaction.$queryRaw<[{ id: string }]>(Prisma.sql`
      INSERT INTO "support"."MerchantSupportThread" (
        "id", "shopId", "createdAt", "updatedAt"
      ) VALUES (${randomUUID()}, ${shopId}, ${now}, ${now})
      ON CONFLICT ("shopId") DO UPDATE SET "updatedAt" = ${now}
      RETURNING "id"
    `);
    const threadId = thread[0]?.id;
    if (!threadId) {
      throw new Error("Unable to create subscription-ended support thread.");
    }

    if (!messageId) {
      messageId = randomUUID();
      const inserted = await transaction.$queryRaw<[{ id: string } | undefined]>(Prisma.sql`
        INSERT INTO "support"."MerchantSupportMessage" (
          "id", "threadId", "kind", "state", "originalBody",
          "sourceLanguageTag", "displayLanguageTag", "systemCode",
          "systemVersion", "sourceKey", "availableAt", "createdAt", "updatedAt"
        ) VALUES (
          ${messageId}, ${threadId}, 'SYSTEM',
          ${needsTranslation ? "PROCESSING" : "AVAILABLE"},
          ${renderSubscriptionEndedMessage(lifecycle.planHandle)},
          ${PLATFORM_SUPPORT_LANGUAGE_TAG}, ${displayLanguageTag},
          'SUBSCRIPTION_ENDED', '1', ${sourceKey},
          ${needsTranslation ? null : now}, ${now}, ${now}
        ) ON CONFLICT ("sourceKey") DO NOTHING
        RETURNING "id"
        `);
      messageId = inserted[0]?.id;
      messageWasInserted = Boolean(messageId);
      if (!messageId) {
        const persisted = await transaction.$queryRaw<[{ id: string } | undefined]>(Prisma.sql`
          SELECT "id"
          FROM "support"."MerchantSupportMessage"
          WHERE "sourceKey" = ${sourceKey}
        `);
        messageId = persisted[0]?.id;
      }
      if (!messageId) {
        throw new Error("Unable to persist subscription-ended support message.");
      }
    }

    await transaction.$executeRaw(Prisma.sql`
      UPDATE "support"."MerchantSupportThread"
      SET "lastMessageAt" = CASE
        WHEN ${!messageWasInserted} THEN "lastMessageAt"
        ELSE ${now}
      END,
      "updatedAt" = ${now}
      WHERE "id" = ${threadId} AND "shopId" = ${shopId}
    `);

    if (!needsTranslation) return null;

    const translations = await transaction.$queryRaw<[{ id: string } | undefined]>(Prisma.sql`
      SELECT "id"
      FROM "support"."MerchantMessageTranslation"
      WHERE "messageId" = ${messageId}
        AND "targetLanguageTag" = ${displayLanguageTag}
    `);
    if (translations[0]?.id) return null;

    const translationId = randomUUID();
    const insertedTranslation = await transaction.$queryRaw<[{ id: string } | undefined]>(Prisma.sql`
      INSERT INTO "support"."MerchantMessageTranslation" (
        "id", "messageId", "direction", "sourceLanguageTag",
        "targetLanguageTag", "status", "createdAt", "updatedAt"
      ) VALUES (
        ${translationId}, ${messageId}, 'SYSTEM_TO_MERCHANT',
        ${PLATFORM_SUPPORT_LANGUAGE_TAG}, ${displayLanguageTag},
        'PENDING', ${now}, ${now}
      ) ON CONFLICT ("messageId", "targetLanguageTag") DO NOTHING
      RETURNING "id"
    `);
    return insertedTranslation[0]?.id ?? null;
  });
}


export class BillingService {
  constructor(
    private readonly provider: BillingProvider =
      new ShopifyBillingProvider(),
    private readonly database = prisma,
    private readonly dispatchTranslation: TranslationDispatch =
      enqueueTranslationBestEffort,
  ) {}

async getSubscription(
  shopId: string,
) {
  return this.database.subscription.findFirst({
    where: {
      shopId,

      status: {
        in: [
          "ACTIVE",
          "TRIALING",
        ],
      },
    },

    include: {
      plan: true,
    },

    orderBy: {
      createdAt: "desc",
    },
  });
}


  async syncSubscription(
    shopId: string,
  ): Promise<Subscription | null> {

    const shop =
      await this.database.shop.findUnique({
        where: {
          id: shopId,
        },
      });

    if (!shop) {
      throw new Error(
        `Shop ${shopId} was not found`,
      );
    }

    if (!shop.shopifyShopId) {
      throw new Error(
        `Shop ${shopId} does not have a Shopify shop ID`,
      );
    }

    const providerSubscription =
      await this.provider.getActiveSubscription({
        shopifyShopId:
          shop.shopifyShopId,
      });

    /*
     * Shopify says there is currently no
     * active subscription.
     */
    if (!providerSubscription) {
      const lifecycle = await this.database.$transaction(async (transaction) => {
        const current = await transaction.subscription.findFirst({
          where: {
            shopId,
            status: {
              in: ["ACTIVE", "TRIALING"],
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            id: true,
            planHandle: true,
            provider: true,
            providerSubscriptionId: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            trialEndsAt: true,
          },
        });

        const subscription = current ?? await transaction.subscription.findUnique({
          where: { shopId },
          select: {
            status: true,
            planHandle: true,
            provider: true,
            providerSubscriptionId: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            trialEndsAt: true,
          },
        });
        if (!subscription) return null;

        if (current) {
          const cancelled = await transaction.subscription.updateMany({
            where: {
              shopId,
              status: {
                in: ["ACTIVE", "TRIALING"],
              },
            },
            data: {
              status: "CANCELLED",
              lastSyncedAt: new Date(),
            },
          });
          if (cancelled.count !== 1) return null;
        }

        return {
          planHandle: subscription.planHandle,
          provider: subscription.provider,
          lifecycleIdentity: deriveLifecycleIdentity(subscription),
        };
      });

      if (lifecycle) {
        try {
          const translationId = await persistSubscriptionEndedNotification(
            this.database,
            shopId,
            lifecycle,
          );
          if (translationId) await this.dispatchTranslation(translationId);
        } catch (error) {
          // Billing state is committed independently of notification persistence.
          if (
            error instanceof Error &&
            error.message === MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY
          ) {
            throw error;
          }
        }
      }

      return null;
    }

    /*
     * Translate Shopify's plan handle into
     * our own BillingPlan.
     */
    const plan =
      await this.database.billingPlan.findUnique({
        where: {
          handle:
            providerSubscription.planHandle,
        },
      });

    if (!plan) {
      throw new Error(
        `No BillingPlan exists for Shopify plan '${providerSubscription.planHandle}'`,
      );
    }

    if (!plan.active) {
      throw new Error(
        `Billing plan '${plan.handle}' is inactive`,
      );
    }

    /*
     * There should be one current subscription
     * for the shop.
     *
     * Because we're retaining subscription history,
     * don't overwrite unrelated old subscriptions.
     */
    const existing = await this.database.subscription.findUnique({
      where: { shopId },
    });

    const data = {
      planId: plan.id,

      provider:
        providerSubscription.provider,

      planHandle:
        providerSubscription.planHandle,

      status:
        providerSubscription.status,

      currentPeriodStart:
        providerSubscription.currentPeriodStart,

      currentPeriodEnd:
        providerSubscription.currentPeriodEnd,

      trialEndsAt:
        providerSubscription.trialEndsAt,

      cancelAtPeriodEnd:
        providerSubscription.cancelAtPeriodEnd,

      providerSubscriptionId:
        providerSubscription.providerSubscriptionId,

      lastSyncedAt:
        new Date(),
    };

    if (existing) {
      return this.database.subscription.update({
        where: {
          id: existing.id,
        },

        data,
      });
    }

    return this.database.subscription.upsert({
      where: { shopId },
      update: data,
      create: {
        shopId,
        ...data,
      },
    });
  }
}


export const billingService =
  new BillingService();