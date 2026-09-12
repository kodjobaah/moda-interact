import { randomUUID } from "node:crypto";

import type {
  BillingPlan,
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
import {
  BILLING_SYSTEM_MESSAGE_CODES,
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
  createShopifyUsageIdempotencyKey,
} from "@modainteract/moda-interact-shared/billing";



import type {
  BillingProvider,
  MerchantShopifyLifecycleState,
  MerchantShopifySubscriptionState,
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

type DurableBillingCycle = {
  billingPeriodId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  billingPeriod?: { id: string; periodStart: Date; periodEnd: Date } | null;
};

function hasDurableBillingPeriod(subscription: DurableBillingCycle): boolean {
  return Boolean(
    subscription.billingPeriodId &&
    subscription.currentPeriodStart &&
    subscription.currentPeriodEnd &&
    subscription.billingPeriod &&
    subscription.billingPeriod.id === subscription.billingPeriodId &&
    subscription.billingPeriod.periodStart.getTime() === subscription.currentPeriodStart.getTime() &&
    subscription.billingPeriod.periodEnd.getTime() === subscription.currentPeriodEnd.getTime(),
  );
}

function hasMatchingBillingCycle(
  subscription: DurableBillingCycle,
  providerSubscription: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null },
  expectedBillingPeriodId?: string,
): boolean {
  if (!hasDurableBillingPeriod(subscription)) return false;
  if (expectedBillingPeriodId && subscription.billingPeriodId !== expectedBillingPeriodId) return false;
  if (!providerSubscription.currentPeriodStart || !providerSubscription.currentPeriodEnd) return false;
  return providerSubscription.currentPeriodStart.getTime() === subscription.currentPeriodStart!.getTime() &&
    providerSubscription.currentPeriodEnd.getTime() === subscription.currentPeriodEnd!.getTime();
}

const MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY =
  "Unable to derive a durable subscription lifecycle identity.";

const RECOVERY_CREDIT_PURCHASE_INTENT = "BUY_RECOVERY_CREDIT_PACK";
export const INITIAL_BILLING_RETRY_DELAY_MS = 60_000;

export type InitialFreeActivationToken = Readonly<{
  subscriptionId: string;
  pendingPlanId: string;
  pendingShopifyPlanHandle: string;
  pendingEffectiveAt: Date;
  nextReconcileAt: Date;
}>;

export type FreeActivationResult = {
  plan: BillingPlan;
  mode: "INITIAL" | "VERIFIED_REPLAY";
  token: InitialFreeActivationToken | null;
};

export type CompletedFreeActivation = {
  subscriptionId: string;
  nextReconcileAt: Date | null;
};

function assertPurchaseId(purchaseId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(purchaseId)) {
    throw new Error("A valid recovery credit purchase ID is required.");
  }
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002",
  );
}

function matchesInitialFreeActivationToken(
  settings: { onboardingCompleted: boolean } | null,
  subscription: {
    id: string;
    pendingPlanId: string | null;
    pendingShopifyPlanHandle: string | null;
    pendingEffectiveAt: Date | null;
    nextReconcileAt: Date | null;
  } | null,
  expected: InitialFreeActivationToken,
): boolean {
  return settings?.onboardingCompleted === false &&
    subscription?.id === expected.subscriptionId &&
    subscription.pendingPlanId === expected.pendingPlanId &&
    subscription.pendingShopifyPlanHandle === expected.pendingShopifyPlanHandle &&
    subscription.pendingEffectiveAt?.getTime() === expected.pendingEffectiveAt.getTime() &&
    subscription.nextReconcileAt?.getTime() === expected.nextReconcileAt.getTime();
}

async function lockInitialFreeActivationState(
  transaction: Prisma.TransactionClient,
  shopId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "shopId"
    FROM "shopify"."ShopSettings"
    WHERE "shopId" = ${shopId}
    FOR UPDATE
  `);
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "billing"."Subscription"
    WHERE "shopId" = ${shopId}
    FOR UPDATE
  `);
}

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

  async prepareFreeActivation(
    shopId: string,
    planHandle: string,
  ): Promise<FreeActivationResult | null> {
    const plan = await this.database.billingPlan.findUnique({
      where: { shopifyPlanHandle: planHandle },
    });
    if (!plan?.active || plan.kind !== BillingPlanKind.FREE) return null;

    const now = new Date();
    return this.database.$transaction(async (transaction) => {
      await lockInitialFreeActivationState(transaction, shopId);
      const currentSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: {
          status: true,
          planId: true,
          observedShopifyPlanHandle: true,
        },
      });
      const settings = await transaction.shopSettings.findUnique({
        where: { shopId },
        select: { onboardingCompleted: true },
      });
      const isVerifiedReplay = currentSubscription?.planId === plan.id &&
        currentSubscription.observedShopifyPlanHandle === planHandle &&
        (currentSubscription.status === SubscriptionProjectionStatus.ACTIVE ||
          currentSubscription.status === SubscriptionProjectionStatus.TRIALING);
      const isInitialActivation = settings?.onboardingCompleted !== true &&
        (!currentSubscription ||
        (currentSubscription.status === SubscriptionProjectionStatus.NO_CONTRACT &&
          currentSubscription.planId === null &&
          !currentSubscription.observedShopifyPlanHandle));
      if (!isInitialActivation && !isVerifiedReplay) return null;

      if (isVerifiedReplay) {
        return { plan, mode: "VERIFIED_REPLAY", token: null };
      }

      const subscription = await transaction.subscription.upsert({
        where: { shopId },
        update: {
          pendingShopifyPlanHandle: planHandle,
          pendingPlanId: plan.id,
          pendingEffectiveAt: now,
          nextReconcileAt: now,
        },
        create: {
          shopId,
          status: SubscriptionProjectionStatus.NO_CONTRACT,
          planId: null,
          pendingShopifyPlanHandle: planHandle,
          pendingPlanId: plan.id,
          pendingEffectiveAt: now,
          nextReconcileAt: now,
        },
      });
      if (
        !subscription.id ||
        !subscription.pendingPlanId ||
        !subscription.pendingShopifyPlanHandle ||
        !subscription.pendingEffectiveAt ||
        !subscription.nextReconcileAt
      ) {
        throw new Error("Initial Free activation token was not persisted.");
      }
      return {
        plan,
        mode: "INITIAL",
        token: Object.freeze({
          subscriptionId: subscription.id,
          pendingPlanId: subscription.pendingPlanId,
          pendingShopifyPlanHandle: subscription.pendingShopifyPlanHandle,
          pendingEffectiveAt: subscription.pendingEffectiveAt,
          nextReconcileAt: subscription.nextReconcileAt,
        }),
      };
    });
  }

  async getSubscriptionProjection(shopId: string) {
    return this.database.subscription.findUnique({
      where: { shopId },
      include: { plan: true, pendingPlan: true, billingPeriod: true },
    });
  }

  async scheduleInitialFreeReconciliationIfCurrent({
    shopId,
    expected,
    nextReconcileAt,
    partnerErrorAt = null,
  }: {
    shopId: string;
    expected: InitialFreeActivationToken;
    nextReconcileAt: Date;
    partnerErrorAt?: Date | null;
  }): Promise<{ subscriptionId: string; nextReconcileAt: Date } | null> {
    return this.database.$transaction(async (transaction) => {
      await lockInitialFreeActivationState(transaction, shopId);
      const settings = await transaction.shopSettings.findUnique({
        where: { shopId },
        select: { onboardingCompleted: true },
      });
      const subscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: {
          id: true,
          pendingPlanId: true,
          pendingShopifyPlanHandle: true,
          pendingEffectiveAt: true,
          nextReconcileAt: true,
        },
      });
      if (!matchesInitialFreeActivationToken(settings, subscription, expected)) {
        return null;
      }
      const updated = await transaction.subscription.update({
        where: { shopId },
        data: {
          nextReconcileAt,
          ...(partnerErrorAt
            ? {
                lastSyncErrorCode: "PARTNER_API_ERROR",
                lastSyncErrorAt: partnerErrorAt,
              }
            : {}),
        },
        select: { id: true, nextReconcileAt: true },
      });
      if (!updated.nextReconcileAt) return null;
      return {
        subscriptionId: updated.id,
        nextReconcileAt: updated.nextReconcileAt,
      };
    });
  }

  async completeFreeActivation(
    shopId: string,
    requestedPlanHandle: string,
  ): Promise<CompletedFreeActivation | null> {
    return this.database.$transaction(async (transaction) => {
      await lockInitialFreeActivationState(transaction, shopId);
      const settings = await transaction.shopSettings.findUnique({
        where: { shopId },
        select: { onboardingCompleted: true },
      });
      const subscription = await transaction.subscription.findUnique({
        where: { shopId },
        include: { plan: true },
      });
      if (
        !subscription ||
        !subscription.plan ||
        subscription.plan.kind !== BillingPlanKind.FREE ||
        subscription.plan.shopifyPlanHandle !== requestedPlanHandle ||
        (subscription.status !== SubscriptionProjectionStatus.ACTIVE && subscription.status !== SubscriptionProjectionStatus.TRIALING) ||
        subscription.observedShopifyPlanHandle !== requestedPlanHandle
      ) {
        return null;
      }
      if (settings?.onboardingCompleted !== true && (
        subscription.pendingShopifyPlanHandle !== requestedPlanHandle ||
        subscription.pendingPlanId !== subscription.planId ||
        !subscription.pendingEffectiveAt
      )) {
        return null;
      }

      await transaction.shopSettings.update({
        where: { shopId },
        data: { onboardingCompleted: true },
      });
      const completionNow = new Date();
      const completedNextReconcileAt = !subscription.plan.recoveryCreditPackEnabled
        ? null
        : subscription.currentPeriodEnd
          ? new Date(Math.max(
              completionNow.getTime(),
              subscription.currentPeriodEnd.getTime() -
                APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
            ))
          : new Date(completionNow.getTime() + INITIAL_BILLING_RETRY_DELAY_MS);
      await transaction.subscription.update({
        where: { shopId },
        data: {
          pendingShopifyPlanHandle: null,
          pendingPlanId: null,
          pendingEffectiveAt: null,
          nextReconcileAt: completedNextReconcileAt,
        },
      });
      return {
        subscriptionId: subscription.id,
        nextReconcileAt: completedNextReconcileAt,
      };
    });
  }

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

  async getMerchantShopifySubscriptionState(
    shopId: string,
  ): Promise<MerchantShopifySubscriptionState> {
    const shop = await this.database.shop.findUnique({
      where: { id: shopId },
    });

    if (!shop) {
      throw new Error(`Shop ${shopId} was not found`);
    }
    if (!shop.shopifyShopId) {
      throw new Error(`Shop ${shopId} does not have a Shopify shop ID`);
    }

    const providerSubscription = await this.provider.getActiveSubscription({
      shopifyShopId: shop.shopifyShopId,
    });

    if (!providerSubscription) {
      return {
        status: "NO_ACTIVE_SUBSCRIPTION",
        subscription: null,
      };
    }

    return this.mapMerchantShopifySubscription(providerSubscription);
  }

  async getMerchantShopifyLifecycleState(
    shopId: string,
  ): Promise<MerchantShopifyLifecycleState> {
    const shop = await this.database.shop.findUnique({
      where: { id: shopId },
    });

    if (!shop) {
      throw new Error(`Shop ${shopId} was not found`);
    }
    if (!shop.shopifyShopId) {
      throw new Error(`Shop ${shopId} does not have a Shopify shop ID`);
    }
    if (!this.provider.getSubscriptionLifecycleSnapshot) {
      throw new Error("Shopify lifecycle snapshot is not supported by the billing provider");
    }

    const snapshot = await this.provider.getSubscriptionLifecycleSnapshot({
      shopifyShopId: shop.shopifyShopId,
    });
    const latestEvent = snapshot.latestLifecycleEvent;
    const activeState = snapshot.activeSubscription
      ? await this.mapMerchantShopifySubscription(snapshot.activeSubscription)
      : null;

    if (latestEvent?.state === "FROZEN") {
      const frozenPlan = latestEvent.planHandle
        ? await this.database.billingPlan.findUnique({
            where: { shopifyPlanHandle: latestEvent.planHandle },
            select: { id: true, name: true, kind: true },
          })
        : null;
      return {
        state: "FROZEN",
        subscription: activeState,
        latestEvent,
        providerPlanHandle: latestEvent.planHandle,
        billingPeriod: latestEvent.billingPeriod,
        modaMapping: frozenPlan
          ? {
              id: frozenPlan.id,
              name: frozenPlan.name,
              kind: frozenPlan.kind === BillingPlanKind.FREE ? "FREE" : "PAID_METERED",
            }
          : null,
        mappingStatus: frozenPlan ? "MAPPED" : "UNMAPPED",
      };
    }

    if (!snapshot.activeSubscription && latestEvent?.state === "CANCELED") {
      return { state: "CANCELED", subscription: null, latestEvent };
    }
    if (snapshot.activeSubscription) {
      return { state: "ACTIVE", subscription: activeState!, latestEvent };
    }
    if (latestEvent) {
      return { state: "UNRESOLVED", subscription: null, latestEvent };
    }
    return { state: "NO_ACTIVE_SUBSCRIPTION", subscription: null, latestEvent: null };
  }

  private async mapMerchantShopifySubscription(
    providerSubscription: NonNullable<Awaited<ReturnType<BillingProvider["getActiveSubscription"]>>>,
  ): Promise<MerchantShopifySubscriptionState & { status: "ACTIVE_SUBSCRIPTION" }> {

    const [currentPlan, pendingPlan] = await Promise.all([
      this.database.billingPlan.findUnique({
        where: { shopifyPlanHandle: providerSubscription.planHandle },
        select: { id: true, name: true, kind: true },
      }),
      providerSubscription.pendingFlatRatePlan
        ? this.database.billingPlan.findUnique({
            where: {
              shopifyPlanHandle: providerSubscription.pendingFlatRatePlan.handle,
            },
            select: { id: true, name: true, kind: true },
          })
        : null,
    ]);

    const mapping = currentPlan
      ? {
          id: currentPlan.id,
          name: currentPlan.name,
          kind: currentPlan.kind === BillingPlanKind.FREE ? "FREE" as const : "PAID_METERED" as const,
        }
      : null;
    const pendingMapping = pendingPlan
      ? {
          id: pendingPlan.id,
          name: pendingPlan.name,
          kind: pendingPlan.kind === BillingPlanKind.FREE ? "FREE" as const : "PAID_METERED" as const,
        }
      : null;

    return {
      status: "ACTIVE_SUBSCRIPTION",
      subscription: {
        planHandle: providerSubscription.currentFlatRatePlan.handle,
        description: providerSubscription.currentFlatRatePlan.description,
        price: providerSubscription.currentFlatRatePlan.price,
        billingPeriod: providerSubscription.billingPeriod,
        currentPeriodStart: providerSubscription.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: providerSubscription.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: providerSubscription.trialEndsAt?.toISOString() ?? null,
        cancelAtEndOfCycle: providerSubscription.cancelAtPeriodEnd,
        pendingUpdate: providerSubscription.pendingFlatRatePlan
          ? {
              planHandle: providerSubscription.pendingFlatRatePlan.handle,
              price: providerSubscription.pendingFlatRatePlan.price,
              effectiveAt: providerSubscription.pendingFlatRatePlan.effectiveAt?.toISOString() ?? null,
            }
          : null,
        usageItems: providerSubscription.usageItems,
      },
      modaMapping: mapping,
      mappingStatus: mapping ? "MAPPED" : "UNMAPPED",
      pendingModaMapping: pendingMapping,
    };
  }

  async getMerchantBillingState(shopId: string) {
    const [shop, subscription, counter, usageTotal, purchasedCounter] = await Promise.all([
      this.database.shop.findUnique({ where: { id: shopId } }),
      this.database.subscription.findUnique({
        where: { shopId },
        include: { plan: true, pendingPlan: true, billingPeriod: true },
      }),
      this.database.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId,
            counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS,
          },
        },
      }),
      this.database.usageEvent.aggregate({
        where: { shopId, metric: "RECOVERY_CONVERSATION" },
        _sum: { quantity: true },
      }),
      this.database.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId,
            counter: EntitlementCounter.PURCHASED_RECOVERY_CREDITS,
          },
        },
      }),
    ]);

    const packMeter = subscription?.plan?.shopifyRecoveryCreditPackEventHandle?.trim() ?? null;
    let recoveryCreditPackMeterVerified = false;
    let recoveryCreditPackPurchaseEligible = false;
    if (
      shop?.shopifyShopId &&
      subscription?.plan?.active &&
      subscription.status !== SubscriptionProjectionStatus.NO_CONTRACT &&
      subscription.plan.recoveryCreditPackEnabled &&
      packMeter
    ) {
      try {
        const providerSubscription = await this.provider.getActiveSubscription({
          shopifyShopId: shop.shopifyShopId,
        });
        recoveryCreditPackMeterVerified = Boolean(
          providerSubscription &&
          providerSubscription.planHandle === subscription.plan.shopifyPlanHandle &&
          providerSubscription.usageEventHandles.includes(packMeter),
        );
        recoveryCreditPackPurchaseEligible = Boolean(
          recoveryCreditPackMeterVerified &&
          subscription &&
          providerSubscription &&
          hasMatchingBillingCycle(subscription, providerSubscription),
        );
      } catch {
        recoveryCreditPackMeterVerified = false;
      }
    }

    const allowance = counter?.grantedQuantity ?? null;
    const committed = counter?.committedQuantity ?? 0;
    const reserved = counter?.reservedQuantity ?? 0;
    const remaining = allowance === null
      ? null
      : Math.max(allowance - committed - reserved, 0);

    return {
      subscription,
      allowance,
      committed,
      reserved,
      remaining,
      usageQuantity: Number(usageTotal._sum.quantity ?? 0),
      purchasedRecoveryCredits: {
        grantedQuantity: purchasedCounter?.grantedQuantity ?? 0,
        committedQuantity: purchasedCounter?.committedQuantity ?? 0,
        reservedQuantity: purchasedCounter?.reservedQuantity ?? 0,
        available: Math.max(
          (purchasedCounter?.grantedQuantity ?? 0)
            - (purchasedCounter?.committedQuantity ?? 0)
            - (purchasedCounter?.reservedQuantity ?? 0),
          0,
        ),
      },
      recoveryCreditPackEnabled: subscription?.plan?.recoveryCreditPackEnabled ?? false,
      recoveryCreditsPerPack: subscription?.plan?.recoveryCreditsPerPack ?? null,
      recoveryCreditPackMeter: packMeter,
      recoveryCreditPackMeterVerified,
      recoveryCreditPackPurchaseEligible,
    };
  }

  async requestRecoveryCreditPack(shopId: string, intent: string, purchaseId: string) {
    if (intent !== RECOVERY_CREDIT_PURCHASE_INTENT) {
      throw new Error("Unsupported billing action.");
    }
    assertPurchaseId(purchaseId);

    const existingPurchase = await this.database.recoveryCreditPurchase.findUnique({
      where: { id: purchaseId },
      include: { usageEvent: true },
    });
    if (existingPurchase) {
      if (existingPurchase.shopId !== shopId) throw new Error("Recovery credit purchase belongs to another shop.");
      return existingPurchase;
    }

    const [shop, subscription] = await Promise.all([
      this.database.shop.findUnique({ where: { id: shopId } }),
      this.database.subscription.findUnique({
        where: { shopId },
        include: { plan: true, billingPeriod: true },
      }),
    ]);
    if (!shop?.shopifyShopId || !subscription?.plan || (subscription.status !== SubscriptionProjectionStatus.ACTIVE && subscription.status !== SubscriptionProjectionStatus.TRIALING)) {
      throw new Error("Recovery credit packs are unavailable for this subscription.");
    }

    const plan = subscription.plan;
    const packMeter = plan.shopifyRecoveryCreditPackEventHandle?.trim();
    const creditsGranted = plan.recoveryCreditsPerPack;
    if (!plan.active || !plan.recoveryCreditPackEnabled || !packMeter || !creditsGranted || creditsGranted <= 0) {
      throw new Error("Recovery credit packs are not enabled for this plan.");
    }
    if (!hasDurableBillingPeriod(subscription)) {
      throw new Error("The current local billing cycle could not be verified.");
    }
    const verifiedBillingPeriodId = subscription.billingPeriodId;
    if (!verifiedBillingPeriodId) {
      throw new Error("The current local billing cycle could not be verified.");
    }
    if (plan.kind === BillingPlanKind.PAID_METERED && (!plan.shopifyUsageEventHandle || plan.shopifyUsageEventHandle === packMeter)) {
      throw new Error("The recovery credit pack meter is not safely mapped.");
    }

    const providerSubscription = await this.provider.getActiveSubscription({ shopifyShopId: shop.shopifyShopId });
    if (!providerSubscription || providerSubscription.planHandle !== plan.shopifyPlanHandle || !providerSubscription.usageEventHandles.includes(packMeter)) {
      throw new Error("The recovery credit pack meter could not be verified with Shopify.");
    }
    if (!hasMatchingBillingCycle(subscription, providerSubscription, verifiedBillingPeriodId)) {
      throw new Error("The current Shopify billing cycle could not be verified.");
    }
    if (plan.kind === BillingPlanKind.PAID_METERED && !providerSubscription.usageEventHandles.includes(plan.shopifyUsageEventHandle as string)) {
      throw new Error("The recovery usage meter could not be verified with Shopify.");
    }

    try {
      return await this.database.$transaction(async (transaction) => {
      const existing = await transaction.recoveryCreditPurchase.findUnique({
        where: { id: purchaseId },
        include: { usageEvent: true },
      });
      if (existing) {
        if (existing.shopId !== shopId) throw new Error("Recovery credit purchase belongs to another shop.");
        return existing;
      }

      const currentSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        include: { plan: true, billingPeriod: true },
      });
      const currentPlan = currentSubscription?.plan;
      const currentPackMeter = currentPlan?.shopifyRecoveryCreditPackEventHandle?.trim();
      if (
        !currentSubscription ||
        !currentPlan ||
        (currentSubscription.status !== SubscriptionProjectionStatus.ACTIVE && currentSubscription.status !== SubscriptionProjectionStatus.TRIALING) ||
        !currentPlan.active ||
        !currentPlan.recoveryCreditPackEnabled ||
        !currentPackMeter ||
        !currentPlan.recoveryCreditsPerPack ||
        currentPlan.recoveryCreditsPerPack <= 0 ||
        !hasMatchingBillingCycle(currentSubscription, providerSubscription, verifiedBillingPeriodId) ||
        currentPlan.shopifyPlanHandle !== providerSubscription.planHandle ||
        currentPackMeter !== packMeter ||
        currentPlan.recoveryCreditsPerPack !== creditsGranted ||
        (currentPlan.kind === BillingPlanKind.PAID_METERED &&
          (!currentPlan.shopifyUsageEventHandle ||
            currentPlan.shopifyUsageEventHandle === currentPackMeter ||
            !providerSubscription.usageEventHandles.includes(currentPlan.shopifyUsageEventHandle)))
      ) {
        throw new Error("Recovery credit pack configuration changed during purchase request.");
      }

      const usageEventId = randomUUID();
      const idempotencyKey = `recovery-credit-pack:${shopId}:${purchaseId}`;
      const usageEvent = await transaction.usageEvent.create({
        data: {
          id: usageEventId,
          shopId,
          billingPeriodId: currentSubscription.billingPeriodId as string,
          metric: "RECOVERY_CREDIT_PACK_PURCHASE",
          quantity: 1,
          idempotencyKey,
          sourceType: "RECOVERY_CREDIT_PURCHASE",
          sourceId: purchaseId,
          shopifyReportState: "PENDING",
          shopifyEventHandle: packMeter,
          shopifyIdempotencyKey: createShopifyUsageIdempotencyKey(shopId, usageEventId),
        },
      });
      return transaction.recoveryCreditPurchase.create({
        data: {
          id: purchaseId,
          shopId,
          planId: currentPlan.id,
          shopifyPlanHandleSnapshot: currentPlan.shopifyPlanHandle,
          shopifyEventHandleSnapshot: packMeter,
          creditsGranted,
          usageEventId: usageEvent.id,
        },
        include: { usageEvent: true },
      });
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        const replay = await this.database.recoveryCreditPurchase.findUnique({
          where: { id: purchaseId },
          include: { usageEvent: true },
        });
        if (replay) {
          if (replay.shopId !== shopId) {
            throw new Error("Recovery credit purchase belongs to another shop.");
          }
          return replay;
        }
      }
      throw error;
    }
  }


  async syncSubscription(
    shopId: string,
    expectedInitialSelection?: InitialFreeActivationToken,
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
        await lockInitialFreeActivationState(transaction, shopId);
        const settings = await transaction.shopSettings.findUnique({
          where: { shopId },
          select: { onboardingCompleted: true },
        });
        const current = await transaction.subscription.findUnique({
          where: { shopId },
          select: {
            id: true,
            status: true,
            observedShopifyPlanHandle: true,
            providerSubscriptionId: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            trialEndsAt: true,
            pendingShopifyPlanHandle: true,
            pendingPlanId: true,
            pendingEffectiveAt: true,
            nextReconcileAt: true,
          },
        });
        if (
          expectedInitialSelection &&
          !matchesInitialFreeActivationToken(settings, current, expectedInitialSelection)
        ) {
          return null;
        }
        const now = new Date();
        const preserveInitialIntent = settings?.onboardingCompleted !== true &&
          current !== null &&
          current.pendingShopifyPlanHandle &&
          current.pendingPlanId;

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
            pendingShopifyPlanHandle: preserveInitialIntent ? current.pendingShopifyPlanHandle : null,
            pendingPlanId: preserveInitialIntent ? current.pendingPlanId : null,
            pendingEffectiveAt: preserveInitialIntent ? current.pendingEffectiveAt : null,
            nextReconcileAt: preserveInitialIntent ? current.nextReconcileAt : null,
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
      await lockInitialFreeActivationState(transaction, shopId);
      const existingSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: {
          id: true,
          status: true,
          pendingShopifyPlanHandle: true,
          pendingPlanId: true,
          pendingEffectiveAt: true,
          nextReconcileAt: true,
        },
      });
      const subscriptionId = existingSubscription?.id ?? randomUUID();
      const settings = await transaction.shopSettings.findUnique({
        where: { shopId },
        select: { onboardingCompleted: true },
      });
      if (
        expectedInitialSelection &&
        !matchesInitialFreeActivationToken(settings, existingSubscription, expectedInitialSelection)
      ) {
        return null;
      }
      const pendingPlan = providerSubscription.pendingPlanHandle
        ? await transaction.billingPlan.findUnique({
            where: { shopifyPlanHandle: providerSubscription.pendingPlanHandle },
            select: { id: true, active: true },
          })
        : null;
      const preserveInitialIntent = settings?.onboardingCompleted !== true &&
        Boolean(existingSubscription?.pendingShopifyPlanHandle) &&
        Boolean(existingSubscription?.pendingPlanId);
      const preservedPendingShopifyPlanHandle = preserveInitialIntent
        ? existingSubscription?.pendingShopifyPlanHandle ?? null
        : providerSubscription.pendingPlanHandle;
      const preservedPendingPlanId = preserveInitialIntent
        ? existingSubscription?.pendingPlanId ?? null
        : pendingPlan?.active ? pendingPlan.id : null;
      const preservedPendingEffectiveAt = preserveInitialIntent
        ? existingSubscription?.pendingEffectiveAt ?? null
        : providerSubscription.pendingPlanHandle
          ? providerSubscription.currentPeriodEnd
          : null;
      const nextReconcileAt = plan?.kind === BillingPlanKind.FREE && plan.recoveryCreditPackEnabled
        ? providerSubscription.currentPeriodEnd
          ? new Date(Math.max(now.getTime(), providerSubscription.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS))
          : new Date(now.getTime() + INITIAL_BILLING_RETRY_DELAY_MS)
        : null;
      const preservedNextReconcileAt = preserveInitialIntent
        ? existingSubscription?.nextReconcileAt ?? null
        : nextReconcileAt;
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
              subscriptionId,
              planId: planIsUsable ? plan?.id ?? null : null,
              shopifyPlanHandleSnapshot: providerSubscription.planHandle,
              planNameSnapshot: plan?.name ?? null,
              planKindSnapshot: plan?.kind ?? null,
              includedRecoveryCreditsGranted: null,
              periodStart: providerSubscription.currentPeriodStart,
              periodEnd: providerSubscription.currentPeriodEnd,
              status: BillingPeriodStatus.OPEN,
            },
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
          pendingShopifyPlanHandle: preservedPendingShopifyPlanHandle,
          pendingPlanId: preservedPendingPlanId,
          pendingEffectiveAt: preservedPendingEffectiveAt,
          nextReconcileAt: preservedNextReconcileAt,
        },
        create: {
          id: subscriptionId,
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
          pendingShopifyPlanHandle: preservedPendingShopifyPlanHandle,
          pendingPlanId: preservedPendingPlanId,
          pendingEffectiveAt: preservedPendingEffectiveAt,
          nextReconcileAt: preservedNextReconcileAt,
        },
      });
    });
  }
}


export const billingService =
  new BillingService();