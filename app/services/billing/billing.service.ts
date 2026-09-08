import { randomUUID } from "node:crypto";

import type {
  PrismaClient,
  Subscription,
} from "@prisma/client";
import {
  BillingPeriodStatus,
  BillingPlanKind,
  EntitlementCounter,
  Prisma,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import {
  PLATFORM_SUPPORT_LANGUAGE_TAG,
  requiresMerchantTranslation,
} from "@modainteract/moda-interact-shared/merchant-communications";
import { BILLING_SYSTEM_MESSAGE_CODES } from "@modainteract/moda-interact-shared/billing";



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
  observedShopifyPlanHandle: string | null;
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
  return `cycle:${subscription.observedShopifyPlanHandle ?? "unknown"}:${cycleFacts.map((fact) => fact ?? "none").join(":")}`;
}

export function renderSubscriptionEndedMessage(planHandle: string): string {
  return `Your ${planHandle} subscription has ended and is no longer active.`;
}

async function persistSubscriptionEndedNotification(
  database: PrismaClient,
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
          ${BILLING_SYSTEM_MESSAGE_CODES.SUBSCRIPTION_ENDED}, '1', ${sourceKey},
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
    private readonly database: PrismaClient = prisma,
    private readonly dispatchTranslation: TranslationDispatch =
      enqueueTranslationBestEffort,
  ) {}

async getSubscription(
  shopId: string,
) {
    const subscription = await this.database.subscription.findUnique({
      where: { shopId },
      include: { plan: true },
    });

    return subscription && (subscription.status === SubscriptionProjectionStatus.ACTIVE || subscription.status === SubscriptionProjectionStatus.TRIALING)
      ? subscription
      : null;
}

  async getMerchantBillingState(shopId: string) {
    const [subscription, counter, adjustmentTotal, usageTotal] = await Promise.all([
      this.database.subscription.findUnique({
        where: { shopId },
        include: { plan: true, pendingPlan: true, billingPeriod: true },
      }),
      this.database.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId,
            counter: EntitlementCounter.FREE_RECOVERY_LIFETIME,
          },
        },
      }),
      this.database.billingAllowanceAdjustment.aggregate({
        where: { shopId, counter: EntitlementCounter.FREE_RECOVERY_LIFETIME },
        _sum: { quantity: true },
      }),
      this.database.usageEvent.aggregate({
        where: { shopId, metric: "RECOVERY_CONVERSATION" },
        _sum: { quantity: true },
      }),
    ]);

    const allowance = subscription?.plan?.kind === BillingPlanKind.FREE
      ? (subscription.plan.freeLifetimeConversationAllowance ?? 0) + (adjustmentTotal._sum.quantity ?? 0)
      : null;
    const committed = counter?.committedQuantity ?? 0;

    return {
      subscription,
      allowance,
      committed,
      remaining: allowance === null ? null : Math.max(allowance - committed, 0),
      usageQuantity: Number(usageTotal._sum.quantity ?? 0),
    };
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
        const current = await transaction.subscription.findUnique({
          where: { shopId },
          select: {
            status: true,
            observedShopifyPlanHandle: true,
            providerSubscriptionId: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            trialEndsAt: true,
          },
        });
        const now = new Date();

        await transaction.subscription.upsert({
          where: { shopId },
          update: {
            planId: null,
            observedShopifyPlanHandle: null,
            status: SubscriptionProjectionStatus.NO_CONTRACT,
            billingPeriodId: null,
            currentPeriodStart: null,
            currentPeriodEnd: null,
            trialEndsAt: null,
            cancelAtPeriodEnd: false,
            providerSubscriptionId: null,
            lastSyncedAt: now,
            lastSyncErrorCode: null,
            lastSyncErrorAt: null,
            pendingShopifyPlanHandle: null,
            pendingPlanId: null,
            pendingEffectiveAt: null,
          },
          create: {
            shopId,
            status: SubscriptionProjectionStatus.NO_CONTRACT,
            lastSyncedAt: now,
          },
        });

        if (!current || (current.status !== SubscriptionProjectionStatus.ACTIVE && current.status !== SubscriptionProjectionStatus.TRIALING)) {
          return null;
        }

        return {
          planHandle: current.observedShopifyPlanHandle ?? "unknown",
          provider: "SHOPIFY",
          lifecycleIdentity: deriveLifecycleIdentity(current),
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

    const plan =
      await this.database.billingPlan.findUnique({
        where: {
          shopifyPlanHandle:
            providerSubscription.planHandle,
        },
      });

    const planIsUsable = Boolean(plan?.active);
    const paidMeterIsPresent = plan?.kind !== BillingPlanKind.PAID_METERED
      || Boolean(plan.shopifyUsageEventHandle && providerSubscription.usageEventHandles.includes(plan.shopifyUsageEventHandle));
    const status = !planIsUsable
      ? SubscriptionProjectionStatus.UNMAPPED
      : !paidMeterIsPresent
        ? SubscriptionProjectionStatus.SYNC_ERROR
        : providerSubscription.status === "TRIALING"
          ? SubscriptionProjectionStatus.TRIALING
          : SubscriptionProjectionStatus.ACTIVE;
    const syncErrorCode = status === SubscriptionProjectionStatus.UNMAPPED
      ? "UNMAPPED_PLAN_HANDLE"
      : status === SubscriptionProjectionStatus.SYNC_ERROR
        ? "MISSING_USAGE_METER"
        : null;
    const now = new Date();

    return this.database.$transaction(async (transaction) => {
      const billingPeriod = providerSubscription.currentPeriodStart && providerSubscription.currentPeriodEnd
        ? await transaction.billingPeriod.upsert({
            where: {
              shopId_periodStart_periodEnd: {
                shopId,
                periodStart: providerSubscription.currentPeriodStart,
                periodEnd: providerSubscription.currentPeriodEnd,
              },
            },
            update: { status: BillingPeriodStatus.OPEN },
            create: {
              shopId,
              periodStart: providerSubscription.currentPeriodStart,
              periodEnd: providerSubscription.currentPeriodEnd,
              status: BillingPeriodStatus.OPEN,
            },
          })
        : null;
      const pendingPlan = providerSubscription.pendingPlanHandle
        ? await transaction.billingPlan.findUnique({
            where: { shopifyPlanHandle: providerSubscription.pendingPlanHandle },
            select: { id: true, active: true },
          })
        : null;

      return transaction.subscription.upsert({
        where: { shopId },
        update: {
          planId: planIsUsable ? plan?.id ?? null : null,
          observedShopifyPlanHandle: providerSubscription.planHandle,
          status,
          billingPeriodId: billingPeriod?.id ?? null,
          currentPeriodStart: providerSubscription.currentPeriodStart,
          currentPeriodEnd: providerSubscription.currentPeriodEnd,
          trialEndsAt: providerSubscription.trialEndsAt,
          cancelAtPeriodEnd: providerSubscription.cancelAtPeriodEnd,
          providerSubscriptionId: providerSubscription.providerSubscriptionId,
          lastSyncedAt: now,
          lastSyncErrorCode: syncErrorCode,
          lastSyncErrorAt: syncErrorCode ? now : null,
          pendingShopifyPlanHandle: providerSubscription.pendingPlanHandle,
          pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
          pendingEffectiveAt: providerSubscription.pendingPlanHandle
            ? providerSubscription.currentPeriodEnd
            : null,
        },
        create: {
          shopId,
          planId: planIsUsable ? plan?.id ?? null : null,
          observedShopifyPlanHandle: providerSubscription.planHandle,
          status,
          billingPeriodId: billingPeriod?.id ?? null,
          currentPeriodStart: providerSubscription.currentPeriodStart,
          currentPeriodEnd: providerSubscription.currentPeriodEnd,
          trialEndsAt: providerSubscription.trialEndsAt,
          cancelAtPeriodEnd: providerSubscription.cancelAtPeriodEnd,
          providerSubscriptionId: providerSubscription.providerSubscriptionId,
          lastSyncedAt: now,
          lastSyncErrorCode: syncErrorCode,
          lastSyncErrorAt: syncErrorCode ? now : null,
          pendingShopifyPlanHandle: providerSubscription.pendingPlanHandle,
          pendingPlanId: pendingPlan?.active ? pendingPlan.id : null,
          pendingEffectiveAt: providerSubscription.pendingPlanHandle
            ? providerSubscription.currentPeriodEnd
            : null,
        },
      });
    });
  }
}


export const billingService =
  new BillingService();