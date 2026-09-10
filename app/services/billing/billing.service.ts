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
import {
  BILLING_SYSTEM_MESSAGE_CODES,
  availablePurchasedRecoveryCredits,
  createShopifyUsageIdempotencyKey,
} from "@modainteract/moda-interact-shared/billing";



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
const SUBSCRIPTION_CANCELLATION_INTENT = "REQUEST_SUBSCRIPTION_CANCELLATION";
const RECOVERY_CREDIT_REFUND_INTENT = "REQUEST_RECOVERY_CREDIT_REFUND";

function assertPurchaseId(purchaseId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(purchaseId)) {
    throw new Error("A valid recovery credit purchase ID is required.");
  }
}

function assertRequestId(requestId: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error(`A valid ${label} is required.`);
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
    const [shop, subscription, counter, purchasedCreditPurchases, adjustmentTotal, usageTotal, purchasedCounter] = await Promise.all([
      this.database.shop.findUnique({ where: { id: shopId } }),
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
      this.database.recoveryCreditPurchase.findMany({
        where: { shopId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        include: { usageEvent: true, refund: true },
      }),
      this.database.billingAllowanceAdjustment.aggregate({
        where: { shopId, counter: EntitlementCounter.FREE_RECOVERY_LIFETIME },
        _sum: { quantity: true },
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
      purchasedRecoveryCredits: {
        grantedQuantity: purchasedCounter?.grantedQuantity ?? 0,
        committedQuantity: purchasedCounter?.committedQuantity ?? 0,
        reservedQuantity: purchasedCounter?.reservedQuantity ?? 0,
        refundingQuantity: purchasedCounter?.refundingQuantity ?? 0,
        available: availablePurchasedRecoveryCredits({
          grantedQuantity: purchasedCounter?.grantedQuantity ?? 0,
          committedQuantity: purchasedCounter?.committedQuantity ?? 0,
          reservedQuantity: purchasedCounter?.reservedQuantity ?? 0,
          refundingQuantity: purchasedCounter?.refundingQuantity ?? 0,
        }),
      },
      recoveryCreditPurchases: purchasedCreditPurchases,
      cancellationRequest: await this.database.subscriptionCancellationRequest.findFirst({
        where: { shopId },
        orderBy: { createdAt: "desc" },
      }),
      recoveryCreditPackEnabled: subscription?.plan?.recoveryCreditPackEnabled ?? false,
      recoveryCreditsPerPack: subscription?.plan?.recoveryCreditsPerPack ?? null,
      recoveryCreditPackMeter: packMeter,
      recoveryCreditPackMeterVerified,
      recoveryCreditPackPurchaseEligible,
    };
  }

  async requestSubscriptionCancellation(
    shopId: string,
    intent: string,
    requestId: string,
    requestedByShopifyUserId?: string | null,
  ) {
    if (intent !== SUBSCRIPTION_CANCELLATION_INTENT) {
      throw new Error("Unsupported billing action.");
    }
    assertRequestId(requestId, "subscription cancellation request ID");

    return this.database.$transaction(async (transaction) => {
      const subscription = await transaction.subscription.findUnique({
        where: { shopId },
      });
      if (
        !subscription ||
        (subscription.status !== SubscriptionProjectionStatus.ACTIVE &&
          subscription.status !== SubscriptionProjectionStatus.TRIALING) ||
        !subscription.providerSubscriptionId ||
        !subscription.observedShopifyPlanHandle
      ) {
        throw new Error("Cancellation is unavailable for this subscription.");
      }

      const requestKey = `subscription-cancel:${shopId}:${subscription.providerSubscriptionId}`;
      const existing = await transaction.subscriptionCancellationRequest.findUnique({
        where: { requestKey },
      });
      if (existing) return existing;

      const request = await transaction.subscriptionCancellationRequest.create({
        data: {
          shopId,
          source: "MERCHANT_UI",
          requestedByShopifyUserId: requestedByShopifyUserId ?? null,
          providerSubscriptionIdSnapshot: subscription.providerSubscriptionId,
          planHandleSnapshot: subscription.observedShopifyPlanHandle,
          currentPeriodEndSnapshot: subscription.currentPeriodEnd,
          mode: "END_OF_CYCLE",
          status: "REQUESTED",
          requestKey,
        },
      });
      await this.createBillingSystemMessage(transaction, {
        shopId,
        systemCode: BILLING_SYSTEM_MESSAGE_CODES.CANCELLATION_REQUEST_RECEIVED,
        sourceKey: `billing-cancellation-request:${request.id}`,
        body: "Your cancellation request was received.",
      });
      return request;
    });
  }

  async requestRecoveryCreditRefund(
    shopId: string,
    intent: string,
    refundRequestId: string,
    purchaseId: string,
    requestedByShopifyUserId?: string | null,
  ) {
    if (intent !== RECOVERY_CREDIT_REFUND_INTENT) {
      throw new Error("Unsupported billing action.");
    }
    assertRequestId(refundRequestId, "recovery credit refund request ID");
    if (!purchaseId.trim()) throw new Error("A recovery credit purchase is required.");

    return this.database.$transaction(async (transaction) => {
      const requestKey = `recovery-credit-refund:${purchaseId}`;
      const existing = await transaction.recoveryCreditRefund.findUnique({
        where: { requestKey },
      });
      if (existing) {
        if (existing.shopId !== shopId) throw new Error("Recovery credit purchase belongs to another shop.");
        return existing;
      }

      const purchase = await transaction.recoveryCreditPurchase.findUnique({
        where: { id: purchaseId },
        include: { usageEvent: true },
      });
      if (!purchase || purchase.shopId !== shopId) {
        throw new Error("Recovery credit purchase belongs to another shop.");
      }
      if (purchase.status !== "ACTIVE") {
        throw new Error("Only active recovery credit packs can be refunded.");
      }

      const request = await transaction.recoveryCreditRefund.create({
        data: {
          shopId,
          purchaseId: purchase.id,
          source: "MERCHANT_UI",
          requestedByShopifyUserId: requestedByShopifyUserId ?? null,
          originalUsageEventIdSnapshot: purchase.usageEventId,
          billingPeriodIdSnapshot: purchase.usageEvent.billingPeriodId,
          planHandleSnapshot: purchase.shopifyPlanHandleSnapshot,
          eventHandleSnapshot: purchase.shopifyEventHandleSnapshot,
          creditsSnapshot: purchase.creditsGranted,
          status: "REQUESTED",
          requestKey,
        },
      });
      await this.createBillingSystemMessage(transaction, {
        shopId,
        systemCode: BILLING_SYSTEM_MESSAGE_CODES.REFUND_REQUEST_RECEIVED,
        sourceKey: `billing-refund-request:${request.id}`,
        body: "Your recovery credit refund request was received.",
      });
      return request;
    });
  }

  private async createBillingSystemMessage(
    transaction: Prisma.TransactionClient,
    input: { shopId: string; systemCode: string; sourceKey: string; body: string },
  ): Promise<void> {
    const settings = await transaction.shopSettings.findUnique({
      where: { shopId: input.shopId },
      select: { defaultLanguageTag: true },
    });
    const displayLanguageTag = trustedSupportLanguageTag(
      settings?.defaultLanguageTag,
    );
    const needsTranslation = requiresMerchantTranslation(
      PLATFORM_SUPPORT_LANGUAGE_TAG,
      displayLanguageTag,
    );
    const now = new Date();
    const thread = await transaction.merchantSupportThread.upsert({
      where: { shopId: input.shopId },
      update: { lastMessageAt: now, updatedAt: now },
      create: { shopId: input.shopId, lastMessageAt: now },
    });
    const message = await transaction.merchantSupportMessage.create({
      data: {
        threadId: thread.id,
        kind: "SYSTEM",
        state: needsTranslation ? "PROCESSING" : "AVAILABLE",
        originalBody: input.body,
        sourceLanguageTag: PLATFORM_SUPPORT_LANGUAGE_TAG,
        displayLanguageTag,
        systemCode: input.systemCode,
        systemVersion: "1",
        sourceKey: input.sourceKey,
        availableAt: needsTranslation ? null : now,
      },
    });
    if (needsTranslation) {
      const translation = await transaction.merchantMessageTranslation.create({
        data: {
          messageId: message.id,
          direction: "SYSTEM_TO_MERCHANT",
          sourceLanguageTag: PLATFORM_SUPPORT_LANGUAGE_TAG,
          targetLanguageTag: displayLanguageTag,
          status: "PENDING",
        },
      });
      await this.dispatchTranslation(translation.id);
    }
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