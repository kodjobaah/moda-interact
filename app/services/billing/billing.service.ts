import { randomUUID } from "node:crypto";

import type {
  BillingPlan,
  PrismaClient,
  Subscription,
} from "@prisma/client";
import {
  BillingPeriodStatus,
  BillingPeriodEntitlementCounterKind,
  BillingPlanKind,
  EntitlementCounter,
  Prisma,
  PromotionCampaignStatus,
  PromotionTargetScope,
  ShopStatus,
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
  deriveShopifyProviderContextIdentity,
} from "@modainteract/moda-interact-shared/billing";



import type {
  BillingPeriodPhase,
  BillingProvider,
  MerchantShopifyLifecycleState,
  MerchantRecoveryCapacityState,
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
import {
  readMerchantPricingPlanForProvider,
  resolveCurrentRecoveryCreditOffers,
} from "../merchant-pricing/merchant-pricing.server.js";

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

export function deriveBillingPeriodPhase(
  periodEnd: Date | null,
  now = new Date(),
): BillingPeriodPhase | null {
  if (!periodEnd) return null;
  const drainStart = periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS;
  if (now.getTime() < drainStart) return "ACTIVE";
  if (now.getTime() < periodEnd.getTime()) return "DRAINING";
  return "RECONCILING";
}

const RECOVERY_CREDIT_PACK_UNAVAILABLE_DURING_TRANSITION =
  "Recovery credit packs are temporarily unavailable while the current Shopify billing cycle is being confirmed.";

function isSafeNonNegativeNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
  planKind?: BillingPlanKind;
}>;

export type InitialPaidActivationToken = InitialFreeActivationToken;

export type FreeActivationResult = {
  plan: BillingPlan;
  mode: "INITIAL" | "VERIFIED_REPLAY";
  token: InitialFreeActivationToken | null;
};

export type CompletedFreeActivation = {
  subscriptionId: string;
  nextReconcileAt: Date | null;
};

export type HostedPlanChangeReturnResult =
  | "current"
  | "pending"
  | "mismatch"
  | "no_active"
  | "unverified";

export type HostedPlanVerificationFence = {
  id: string | null;
  updatedAt: Date | null;
  status: SubscriptionProjectionStatus | null;
  observedShopifyPlanHandle: string | null;
  planId: string | null;
  billingPeriodId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean | null;
  pendingShopifyPlanHandle: string | null;
  pendingPlanId: string | null;
  pendingEffectiveAt: Date | null;
  nextReconcileAt: Date | null;
  lastSyncedAt: Date | null;
  lastSyncErrorCode: string | null;
  lastSyncErrorAt: Date | null;
};

type HostedPlanVerificationFenceSource = HostedPlanVerificationFence | null;

function sameFenceDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function sameHostedPlanVerificationFence(
  left: HostedPlanVerificationFenceSource,
  right: HostedPlanVerificationFenceSource,
): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id &&
    sameFenceDate(left.updatedAt, right.updatedAt) &&
    left.status === right.status &&
    left.observedShopifyPlanHandle === right.observedShopifyPlanHandle &&
    left.planId === right.planId &&
    left.billingPeriodId === right.billingPeriodId &&
    sameFenceDate(left.currentPeriodStart, right.currentPeriodStart) &&
    sameFenceDate(left.currentPeriodEnd, right.currentPeriodEnd) &&
    sameFenceDate(left.trialEndsAt, right.trialEndsAt) &&
    left.cancelAtPeriodEnd === right.cancelAtPeriodEnd &&
    left.pendingShopifyPlanHandle === right.pendingShopifyPlanHandle &&
    left.pendingPlanId === right.pendingPlanId &&
    sameFenceDate(left.pendingEffectiveAt, right.pendingEffectiveAt) &&
    sameFenceDate(left.nextReconcileAt, right.nextReconcileAt) &&
    sameFenceDate(left.lastSyncedAt, right.lastSyncedAt) &&
    left.lastSyncErrorCode === right.lastSyncErrorCode &&
    sameFenceDate(left.lastSyncErrorAt, right.lastSyncErrorAt);
}

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

function hasProviderBeforeEvidence(
  usage: { quantity: number | null; costAmount: string | null; costCurrency: string | null } | null | undefined,
): usage is { quantity: number; costAmount: string; costCurrency: string } {
  return Boolean(
    usage &&
    isSafeNonNegativeNumber(usage.quantity) &&
    typeof usage.costAmount === "string" &&
    usage.costAmount.trim() &&
    typeof usage.costCurrency === "string" &&
    /^[A-Z]{3}$/.test(usage.costCurrency),
  );
}

function executableProviderSubscription(
  snapshot: {
    activeSubscription: import("./billing.types").ProviderSubscription | null;
    latestLifecycleEvent: import("./billing.types").ProviderSubscriptionLifecycleEvent | null;
  },
): import("./billing.types").ProviderSubscription | null {
  if (snapshot.latestLifecycleEvent?.state === "FROZEN") return null;
  return snapshot.activeSubscription ?? null;
}

function sameRecoveryCreditProviderEvidence(
  left: import("./billing.types").ProviderSubscription,
  right: import("./billing.types").ProviderSubscription,
  eventHandle: string,
): boolean {
  const comparable = (subscription: import("./billing.types").ProviderSubscription) => ({
    planHandle: subscription.planHandle,
    status: subscription.status,
    providerSubscriptionId: subscription.providerSubscriptionId,
    currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    usageEventHandles: [...subscription.usageEventHandles].sort(),
    usageItem: subscription.usageItems.find((item) => item.handle === eventHandle) ?? null,
  });

  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function unresolvedPurchaseMessage(): string {
  return "A recovery credit pack is already awaiting Shopify confirmation.";
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

async function lockShopForInitialPaidActivation(
  transaction: Prisma.TransactionClient,
  shopId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "shopify"."Shop"
    WHERE "id" = ${shopId}
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

  private async readMerchantPricingPlan(planHandle: string) {
    if (this.database.merchantPricingPlan?.findUnique) {
      const plan = await this.database.merchantPricingPlan.findUnique({
        where: { shopifyPlanHandle: planHandle },
        include: { usageEvents: { orderBy: { position: "asc" }, include: { tiers: { orderBy: { position: "asc" } } } } },
      });
      return plan
        ? {
            shopifyPlanHandle: plan.shopifyPlanHandle,
            usageEvents: plan.usageEvents.map((event: { position: number; eventHandle: string; creditsGrantedPerUnit: number }) => ({
              cataloguePosition: event.position,
              eventHandle: event.eventHandle,
              creditsGrantedPerUnit: event.creditsGrantedPerUnit,
            })),
          }
        : null;
    }
    return readMerchantPricingPlanForProvider({ planHandle });
  }

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
          planKind: BillingPlanKind.FREE,
        }),
      };
    });
  }

  async preparePaidActivation(
    shopId: string,
    planHandle: string,
  ): Promise<FreeActivationResult | null> {
    const plan = await this.database.billingPlan.findUnique({ where: { shopifyPlanHandle: planHandle } });
    if (!plan?.active || plan.kind !== BillingPlanKind.PAID_METERED) return null;

    const now = new Date();
    return this.database.$transaction(async (transaction) => {
      await lockInitialFreeActivationState(transaction, shopId);
      const currentSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: { status: true, planId: true, observedShopifyPlanHandle: true },
      });
      const settings = await transaction.shopSettings.findUnique({ where: { shopId }, select: { onboardingCompleted: true } });
      const isInitialActivation = settings?.onboardingCompleted !== true &&
        (!currentSubscription || (currentSubscription.status === SubscriptionProjectionStatus.NO_CONTRACT && currentSubscription.planId === null && !currentSubscription.observedShopifyPlanHandle));
      if (!isInitialActivation) return null;

      const subscription = await transaction.subscription.upsert({
        where: { shopId },
        update: { pendingShopifyPlanHandle: planHandle, pendingPlanId: plan.id, pendingEffectiveAt: now, nextReconcileAt: now },
        create: { shopId, status: SubscriptionProjectionStatus.NO_CONTRACT, planId: null, pendingShopifyPlanHandle: planHandle, pendingPlanId: plan.id, pendingEffectiveAt: now, nextReconcileAt: now },
      });
      if (!subscription.id || !subscription.pendingPlanId || !subscription.pendingShopifyPlanHandle || !subscription.pendingEffectiveAt || !subscription.nextReconcileAt) {
        throw new Error("Initial Paid activation token was not persisted.");
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
          planKind: BillingPlanKind.PAID_METERED,
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

  async getHostedPlanVerificationFence(
    shopId: string,
  ): Promise<HostedPlanVerificationFence | null> {
    const subscription = await this.database.subscription.findUnique({
      where: { shopId },
      select: {
        id: true,
        updatedAt: true,
        status: true,
        observedShopifyPlanHandle: true,
        planId: true,
        billingPeriodId: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        trialEndsAt: true,
        cancelAtPeriodEnd: true,
        pendingShopifyPlanHandle: true,
        pendingPlanId: true,
        pendingEffectiveAt: true,
        nextReconcileAt: true,
        lastSyncedAt: true,
        lastSyncErrorCode: true,
        lastSyncErrorAt: true,
      },
    });
    return subscription;
  }

  async recordHostedPlanChangeReturn({
    shopId,
    requestedPlanHandle,
    state,
    verificationFence,
  }: {
    shopId: string;
    requestedPlanHandle: string;
    state: MerchantShopifySubscriptionState;
    verificationFence: HostedPlanVerificationFence | null;
  }): Promise<{ result: HostedPlanChangeReturnResult; subscriptionId: string | null; nextReconcileAt: Date | null }> {
    const now = new Date();
    return this.database.$transaction(async (transaction) => {
      await lockInitialFreeActivationState(transaction, shopId);
      const current = await transaction.subscription.findUnique({
        where: { shopId },
        select: {
          id: true,
          updatedAt: true,
          status: true,
          observedShopifyPlanHandle: true,
          planId: true,
          billingPeriodId: true,
          pendingPlanId: true,
          pendingShopifyPlanHandle: true,
          pendingEffectiveAt: true,
          nextReconcileAt: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          trialEndsAt: true,
          cancelAtPeriodEnd: true,
          lastSyncedAt: true,
          lastSyncErrorCode: true,
          lastSyncErrorAt: true,
        },
      });

      if (!sameHostedPlanVerificationFence(current, verificationFence)) {
        return { result: "unverified", subscriptionId: current?.id ?? null, nextReconcileAt: null };
      }

      if (state.status === "NO_ACTIVE_SUBSCRIPTION") {
        if (!current) return { result: "no_active", subscriptionId: null, nextReconcileAt: null };
        const nextReconcileAt = now;
        const updated = await transaction.subscription.update({
          where: { shopId },
          data: { nextReconcileAt, lastSyncErrorCode: null, lastSyncErrorAt: null },
          select: { id: true, nextReconcileAt: true },
        });
        return { result: "no_active", subscriptionId: updated.id, nextReconcileAt: updated.nextReconcileAt };
      }

      const provider = state.subscription;
      const currentHandle = provider.planHandle;
      const pendingHandle = provider.pendingUpdate?.planHandle ?? null;
      const result: HostedPlanChangeReturnResult = requestedPlanHandle === currentHandle
        ? "current"
        : requestedPlanHandle === pendingHandle
          ? "pending"
          : "mismatch";

      if (result === "mismatch" || !current) {
        return { result, subscriptionId: current?.id ?? null, nextReconcileAt: current?.nextReconcileAt ?? null };
      }

      const nextReconcileAt = result === "pending"
        ? provider.pendingUpdate?.effectiveAt
          ? new Date(provider.pendingUpdate.effectiveAt)
          : now
        : now;
      const pendingPlan = pendingHandle
        ? await transaction.billingPlan.findUnique({
            where: { shopifyPlanHandle: pendingHandle },
            select: { id: true, active: true },
          })
        : null;
      const mappedPendingPlanId = pendingPlan?.active ? pendingPlan.id : null;
      const updated = await transaction.subscription.update({
        where: { shopId },
        data: {
          observedShopifyPlanHandle: currentHandle,
          currentPeriodStart: provider.currentPeriodStart ? new Date(provider.currentPeriodStart) : null,
          currentPeriodEnd: provider.currentPeriodEnd ? new Date(provider.currentPeriodEnd) : null,
          trialEndsAt: provider.trialEndsAt ? new Date(provider.trialEndsAt) : null,
          cancelAtPeriodEnd: provider.cancelAtEndOfCycle,
          pendingShopifyPlanHandle: pendingHandle,
          pendingPlanId: mappedPendingPlanId,
          pendingEffectiveAt: provider.pendingUpdate?.effectiveAt
            ? new Date(provider.pendingUpdate.effectiveAt)
            : null,
          nextReconcileAt,
          lastSyncedAt: now,
          lastSyncErrorCode: null,
          lastSyncErrorAt: null,
        },
        select: { id: true, nextReconcileAt: true },
      });
      return { result, subscriptionId: updated.id, nextReconcileAt: updated.nextReconcileAt };
    });
  }

  async recordHostedPlanVerificationFailure(
    shopId: string,
    verificationFence: HostedPlanVerificationFence | null,
  ): Promise<{ subscriptionId: string; nextReconcileAt: Date } | null> {
    const nextReconcileAt = new Date(Date.now() + INITIAL_BILLING_RETRY_DELAY_MS);
    return this.database.$transaction(async (transaction) => {
      await lockInitialFreeActivationState(transaction, shopId);
      const current = await transaction.subscription.findUnique({
        where: { shopId },
        select: {
          id: true,
          updatedAt: true,
          status: true,
          observedShopifyPlanHandle: true,
          planId: true,
          billingPeriodId: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          trialEndsAt: true,
          cancelAtPeriodEnd: true,
          pendingShopifyPlanHandle: true,
          pendingPlanId: true,
          pendingEffectiveAt: true,
          nextReconcileAt: true,
          lastSyncedAt: true,
          lastSyncErrorCode: true,
          lastSyncErrorAt: true,
        },
      });
      if (!sameHostedPlanVerificationFence(current, verificationFence)) return null;
      if (!current) return null;
      const updated = await transaction.subscription.updateMany({
        where: { shopId },
        data: {
          nextReconcileAt,
          lastSyncErrorCode: "PARTNER_API_ERROR",
          lastSyncErrorAt: new Date(),
        },
      });
      if (!updated.count) return null;
      const subscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: { id: true, nextReconcileAt: true },
      });
      return subscription?.nextReconcileAt
        ? { subscriptionId: subscription.id, nextReconcileAt: subscription.nextReconcileAt }
        : null;
    });
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

  async getMerchantRecoveryCapacityState(
    shopId: string,
  ): Promise<MerchantRecoveryCapacityState> {
    const [subscription, lifetimeCounter, purchasedCounter, selection] = await Promise.all([
      this.database.subscription.findUnique({
        where: { shopId },
        include: {
          plan: true,
          billingPeriod: {
            include: {
              entitlementCounters: {
                where: {
                  counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
                },
              },
            },
          },
        },
      }),
      this.database.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId,
            counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS,
          },
        },
      }),
      this.database.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId,
            counter: EntitlementCounter.PURCHASED_RECOVERY_CREDITS,
          },
        },
      }),
      this.database.merchantPromotionSelection.findUnique({
        where: { shopId },
        include: {
          promotionalCreditGrant: {
            include: { campaign: true },
          },
        },
      }),
    ]);

    const freeLifetime = lifetimeCounter
      ? {
          granted: lifetimeCounter.grantedQuantity,
          committed: lifetimeCounter.committedQuantity,
          reserved: lifetimeCounter.reservedQuantity,
          remaining: Math.max(
            lifetimeCounter.grantedQuantity -
              lifetimeCounter.committedQuantity -
              lifetimeCounter.reservedQuantity,
            0,
          ),
        }
      : null;
    const purchased = {
      granted: purchasedCounter?.grantedQuantity ?? 0,
      committed: purchasedCounter?.committedQuantity ?? 0,
      reserved: purchasedCounter?.reservedQuantity ?? 0,
      refunding: purchasedCounter?.refundingQuantity ?? 0,
      available: Math.max(
        (purchasedCounter?.grantedQuantity ?? 0) -
          (purchasedCounter?.committedQuantity ?? 0) -
          (purchasedCounter?.reservedQuantity ?? 0) -
          (purchasedCounter?.refundingQuantity ?? 0),
        0,
      ),
    };
    const selectedGrant = selection?.promotionalCreditGrant;
    const campaign = selectedGrant?.campaign;
    const now = new Date();
    const promotionTargetMatches = campaign && (
      campaign.scope === PromotionTargetScope.GLOBAL ||
      (campaign.scope === PromotionTargetScope.PLAN && campaign.targetPlanId === subscription?.planId) ||
      (campaign.scope === PromotionTargetScope.SHOP && campaign.targetShopId === shopId)
    );
    const promotional = selectedGrant && campaign && promotionTargetMatches &&
      campaign.status === PromotionCampaignStatus.ACTIVE &&
      campaign.startsAt <= now && campaign.expiresAt > now
      && selectedGrant.quantity >= 0
      && selectedGrant.committedQuantity >= 0
      && selectedGrant.reservedQuantity >= 0
      && selectedGrant.committedQuantity + selectedGrant.reservedQuantity <= selectedGrant.quantity
      ? {
          granted: selectedGrant.quantity,
          committed: selectedGrant.committedQuantity,
          reserved: selectedGrant.reservedQuantity,
          remaining: Math.max(
            selectedGrant.quantity -
              selectedGrant.committedQuantity -
              selectedGrant.reservedQuantity,
            0,
          ),
        }
      : { granted: 0, committed: 0, reserved: 0, remaining: 0 };

    const reconciledPlanMapping = subscription?.plan && subscription.plan.active
      ? {
          id: subscription.plan.id,
          shopifyPlanHandle: subscription.plan.shopifyPlanHandle,
          name: subscription.plan.name,
          kind: subscription.plan.kind === BillingPlanKind.FREE ? "FREE" as const : "PAID_METERED" as const,
        }
      : null;
    const paidPeriod = subscription?.billingPeriod;
    const periodCounter = paidPeriod?.entitlementCounters.find(
      ({ counter }) => counter === BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
    );
    const paidIncluded = reconciledPlanMapping?.kind === "PAID_METERED" &&
      (subscription?.status === SubscriptionProjectionStatus.ACTIVE ||
        subscription?.status === SubscriptionProjectionStatus.TRIALING ||
        subscription?.status === SubscriptionProjectionStatus.FROZEN) &&
      paidPeriod &&
      periodCounter &&
      paidPeriod.status === BillingPeriodStatus.OPEN &&
      paidPeriod.shopId === shopId &&
      paidPeriod.subscriptionId === subscription.id &&
      paidPeriod.planId === subscription.planId &&
      subscription.billingPeriodId === paidPeriod.id &&
      subscription.observedShopifyPlanHandle === subscription.plan?.shopifyPlanHandle &&
      paidPeriod.shopifyPlanHandleSnapshot === subscription.plan?.shopifyPlanHandle &&
      paidPeriod.planKindSnapshot === BillingPlanKind.PAID_METERED &&
      subscription.currentPeriodStart &&
      subscription.currentPeriodEnd &&
      paidPeriod.periodStart.getTime() === subscription.currentPeriodStart.getTime() &&
      paidPeriod.periodEnd.getTime() === subscription.currentPeriodEnd.getTime() &&
      paidPeriod.periodStart < paidPeriod.periodEnd &&
      periodCounter.shopId === shopId &&
      periodCounter.billingPeriodId === paidPeriod.id &&
      periodCounter.grantedQuantity >= 0 &&
      periodCounter.committedQuantity >= 0 &&
      periodCounter.reservedQuantity >= 0 &&
      periodCounter.forfeitedQuantity >= 0 &&
      periodCounter.committedQuantity + periodCounter.reservedQuantity + periodCounter.forfeitedQuantity <= periodCounter.grantedQuantity
      ? {
          billingPeriodId: paidPeriod.id,
          periodStart: paidPeriod.periodStart.toISOString(),
          periodEnd: paidPeriod.periodEnd.toISOString(),
          granted: periodCounter.grantedQuantity,
          committed: periodCounter.committedQuantity,
          reserved: periodCounter.reservedQuantity,
          forfeited: periodCounter.forfeitedQuantity,
          remaining: Math.max(
            periodCounter.grantedQuantity -
              periodCounter.committedQuantity -
              periodCounter.reservedQuantity -
              periodCounter.forfeitedQuantity,
            0,
          ),
        }
      : null;

    const base = {
      reconciledPlanMapping,
      observedShopifyPlanHandle: subscription?.observedShopifyPlanHandle ?? null,
      freeLifetime,
      paidIncluded,
      promotional,
      purchased,
      topUpConfiguration: {
        enabled: Boolean(subscription?.plan?.recoveryCreditPackEnabled),
        creditsPerPack: subscription?.plan?.recoveryCreditsPerPack ?? null,
      },
    };
    if (!subscription || subscription.status === SubscriptionProjectionStatus.NO_CONTRACT) {
      return { ...base, availability: "CONTRACT_REQUIRED", capacitySource: null, canStartRecovery: false };
    }
    if (subscription.status === SubscriptionProjectionStatus.FROZEN) {
      return { ...base, availability: "CONTRACT_FROZEN", capacitySource: null, canStartRecovery: false };
    }
    if (
      (subscription.status !== SubscriptionProjectionStatus.ACTIVE && subscription.status !== SubscriptionProjectionStatus.TRIALING) ||
      !reconciledPlanMapping ||
      subscription.observedShopifyPlanHandle !== subscription.plan?.shopifyPlanHandle ||
      (reconciledPlanMapping.kind === "PAID_METERED" && !paidIncluded)
    ) {
      return { ...base, availability: "CONFIGURATION_UNAVAILABLE", capacitySource: null, canStartRecovery: false };
    }

    if (promotional.remaining <= 0 &&
      !(reconciledPlanMapping.kind === "PAID_METERED" && paidIncluded!.remaining > 0) &&
      purchased.available <= 0 &&
      !freeLifetime) {
      return { ...base, availability: "CONFIGURATION_UNAVAILABLE", capacitySource: null, canStartRecovery: false };
    }

    const capacitySource = promotional.remaining > 0
      ? "PROMOTIONAL"
      : reconciledPlanMapping.kind === "PAID_METERED" && paidIncluded!.remaining > 0
        ? "PAID_INCLUDED"
        : purchased.available > 0
          ? "PURCHASED"
          : freeLifetime?.remaining && freeLifetime.remaining > 0
            ? "FREE_LIFETIME"
            : null;
    return {
      ...base,
      availability: capacitySource ? "AVAILABLE" : "EXHAUSTED",
      capacitySource: capacitySource ?? "EXHAUSTED",
      canStartRecovery: Boolean(capacitySource),
    };
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
        include: {
          plan: true,
          pendingPlan: true,
          billingPeriod: {
            include: {
              entitlementCounters: {
                where: {
                  counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
                },
              },
            },
          },
        },
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

    let recoveryCreditOffers: import("./billing.types").RecoveryCreditOffer[] = [];
    let recoveryCreditOfferDiagnostics: Array<{ code: string; handle: string }> = [];
    let recoveryCreditOfferVerificationState: import("./billing.types").RecoveryCreditOfferVerificationState = "VERIFIED";
    let recoveryCreditPackPurchaseEligible = false;
    let unavailableReason: string | null = null;
    const hasExactOpenLocalCycle = Boolean(
      shop?.status === ShopStatus.ACTIVE &&
      subscription?.status !== undefined &&
      (subscription.status === SubscriptionProjectionStatus.ACTIVE || subscription.status === SubscriptionProjectionStatus.TRIALING) &&
      subscription?.plan?.active === true &&
      hasDurableBillingPeriod(subscription) &&
      subscription.billingPeriod?.status === BillingPeriodStatus.OPEN &&
      subscription.currentPeriodStart &&
      subscription.currentPeriodEnd &&
      subscription.currentPeriodStart.getTime() < subscription.currentPeriodEnd.getTime(),
    );
    const billingPeriodPhase: BillingPeriodPhase | null = subscription &&
      hasDurableBillingPeriod(subscription) &&
      subscription.billingPeriod?.status === BillingPeriodStatus.OPEN &&
      subscription.currentPeriodStart!.getTime() < subscription.currentPeriodEnd!.getTime()
      ? deriveBillingPeriodPhase(subscription.currentPeriodEnd)
      : null;
    if (
      shop?.shopifyShopId &&
      billingPeriodPhase !== null
    ) {
      try {
        if (!this.provider.getSubscriptionLifecycleSnapshot) {
          throw new Error("Shopify lifecycle snapshot is not supported by the billing provider");
        }
        const lifecycleSnapshot = await this.provider.getSubscriptionLifecycleSnapshot({
          shopifyShopId: shop.shopifyShopId,
        });
        const providerSubscription = executableProviderSubscription(lifecycleSnapshot);
        if (providerSubscription) {
          const merchantPricingPlan = await this.readMerchantPricingPlan(providerSubscription.planHandle);
          const resolved = resolveCurrentRecoveryCreditOffers({ providerSubscription, merchantPricingPlan });
          recoveryCreditOffers = resolved.offers;
          recoveryCreditOfferDiagnostics = resolved.diagnostics;
          recoveryCreditPackPurchaseEligible = recoveryCreditOffers.length > 0;
        }
        recoveryCreditPackPurchaseEligible = Boolean(
          recoveryCreditPackPurchaseEligible &&
          subscription &&
          hasExactOpenLocalCycle &&
          providerSubscription &&
          hasMatchingBillingCycle(subscription, providerSubscription) &&
          subscription?.billingPeriod?.status === BillingPeriodStatus.OPEN &&
          billingPeriodPhase === "ACTIVE",
        );
        if (!recoveryCreditPackPurchaseEligible) {
          unavailableReason = "Recovery credit offers are not currently available.";
        }
      } catch {
        recoveryCreditOffers = [];
        recoveryCreditOfferDiagnostics = [];
        recoveryCreditOfferVerificationState = "VERIFICATION_UNAVAILABLE";
        recoveryCreditPackPurchaseEligible = false;
        unavailableReason = "Shopify billing details could not be verified.";
      }
    }

    const latestPurchase = await (this.database.recoveryCreditPurchase?.findFirst?.({
      where: { shopId },
      orderBy: { createdAt: "desc" },
      include: { usageEvent: true },
    }) ?? Promise.resolve(null));
    if (latestPurchase?.status === "REQUESTED") {
      recoveryCreditPackPurchaseEligible = false;
    }

    const isPaid = subscription?.plan?.kind === BillingPlanKind.PAID_METERED;
    const periodCounter = subscription?.billingPeriod?.entitlementCounters.find(
      ({ counter }) => counter === BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
    ) ?? null;
    const paidPeriod = subscription?.billingPeriod;
    const includedGrant = paidPeriod?.includedRecoveryCreditsGranted;
    const hasValidPaidPeriod = Boolean(
      isPaid &&
      subscription?.status === SubscriptionProjectionStatus.ACTIVE &&
      subscription.plan?.active === true &&
      subscription.plan.kind === BillingPlanKind.PAID_METERED &&
      subscription.observedShopifyPlanHandle === subscription.plan.shopifyPlanHandle &&
      hasDurableBillingPeriod(subscription) &&
      paidPeriod?.id === subscription.billingPeriodId &&
      paidPeriod.shopId === shopId &&
      paidPeriod.subscriptionId === subscription.id &&
      paidPeriod.planId === subscription.plan.id &&
      paidPeriod.shopifyPlanHandleSnapshot === subscription.plan.shopifyPlanHandle &&
      paidPeriod.planKindSnapshot === BillingPlanKind.PAID_METERED &&
      paidPeriod.status === BillingPeriodStatus.OPEN &&
      paidPeriod.periodStart < paidPeriod.periodEnd &&
      isSafeNonNegativeInteger(includedGrant) &&
      periodCounter?.shopId === shopId &&
      periodCounter.billingPeriodId === paidPeriod.id &&
      periodCounter.grantedQuantity === includedGrant &&
      isSafeNonNegativeInteger(periodCounter.committedQuantity) &&
      isSafeNonNegativeInteger(periodCounter.reservedQuantity) &&
      isSafeNonNegativeInteger(periodCounter.forfeitedQuantity) &&
      periodCounter.committedQuantity +
        periodCounter.reservedQuantity +
        periodCounter.forfeitedQuantity <= periodCounter.grantedQuantity,
    );
    const paidIncluded = hasValidPaidPeriod && periodCounter
      ? {
          grantedQuantity: periodCounter.grantedQuantity,
          committedQuantity: periodCounter.committedQuantity,
          reservedQuantity: periodCounter.reservedQuantity,
          forfeitedQuantity: periodCounter.forfeitedQuantity,
          remaining: Math.max(
            periodCounter.grantedQuantity -
              periodCounter.committedQuantity -
              periodCounter.reservedQuantity -
              periodCounter.forfeitedQuantity,
            0,
          ),
        }
      : null;
    const allowance = isPaid ? null : counter?.grantedQuantity ?? null;
    const committed = isPaid ? 0 : counter?.committedQuantity ?? 0;
    const reserved = isPaid ? 0 : counter?.reservedQuantity ?? 0;
    const remaining = isPaid
      ? null
      : allowance === null
        ? null
        : Math.max(allowance - committed - reserved, 0);

    return {
      subscription,
      allowance,
      committed,
      reserved,
      remaining,
      paidIncluded,
      paidConfigurationUnavailable: isPaid && !paidIncluded,
      lifetimeFree: {
        grantedQuantity: counter?.grantedQuantity ?? 0,
        committedQuantity: counter?.committedQuantity ?? 0,
        reservedQuantity: counter?.reservedQuantity ?? 0,
        remaining: Math.max(
          (counter?.grantedQuantity ?? 0) -
            (counter?.committedQuantity ?? 0) -
            (counter?.reservedQuantity ?? 0),
          0,
        ),
      },
      usageQuantity: Number(usageTotal._sum.quantity ?? 0),
      purchasedRecoveryCredits: {
        grantedQuantity: purchasedCounter?.grantedQuantity ?? 0,
        committedQuantity: purchasedCounter?.committedQuantity ?? 0,
        reservedQuantity: purchasedCounter?.reservedQuantity ?? 0,
        refundingQuantity: purchasedCounter?.refundingQuantity ?? 0,
        available: Math.max(
          (purchasedCounter?.grantedQuantity ?? 0)
            - (purchasedCounter?.committedQuantity ?? 0)
            - (purchasedCounter?.reservedQuantity ?? 0)
            - (purchasedCounter?.refundingQuantity ?? 0),
          0,
        ),
      },
      recoveryCreditOffers,
      recoveryCreditOfferDiagnostics,
      recoveryCreditOfferVerificationState,
      recoveryCreditPackMeterVerified: recoveryCreditOfferVerificationState === "VERIFIED",
      recoveryCreditPackPurchaseEligible,
      configured: recoveryCreditOffers.length > 0,
      purchaseEligible: recoveryCreditPackPurchaseEligible,
      unavailableReason,
      latestPurchase: latestPurchase
        ? {
            id: latestPurchase.id,
            status: latestPurchase.status,
            creditsGranted: latestPurchase.creditsGranted,
            currentAmount: latestPurchase.currentAmount,
            reservedAmount: latestPurchase.reservedAmount,
            createdAt: latestPurchase.createdAt.toISOString(),
            activatedAt: latestPurchase.activatedAt?.toISOString() ?? null,
            usageReportState: latestPurchase.usageEvent?.shopifyReportState ?? "UNKNOWN",
          }
        : null,
      billingPeriodPhase,
    };
  }

  async requestRecoveryCreditPack(shopId: string, intent: string, purchaseId: string, eventHandle: string) {
    if (intent !== RECOVERY_CREDIT_PURCHASE_INTENT) {
      throw new Error("Unsupported billing action.");
    }
    assertPurchaseId(purchaseId);
    if (typeof eventHandle !== "string" || !eventHandle.trim() || eventHandle.length > 128) {
      throw new Error("A valid recovery credit offer is required.");
    }

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
    if (shop?.status !== ShopStatus.ACTIVE || !shop.shopifyShopId || !subscription?.plan || (subscription.status !== SubscriptionProjectionStatus.ACTIVE && subscription.status !== SubscriptionProjectionStatus.TRIALING)) {
      throw new Error("Recovery credit packs are unavailable for this subscription.");
    }

    const plan = subscription.plan;
    if (!plan.active) {
      throw new Error("Recovery credit packs are unavailable for this plan.");
    }
    if (!hasDurableBillingPeriod(subscription)) {
      throw new Error("The current local billing cycle could not be verified.");
    }
    const verifiedBillingPeriodId = subscription.billingPeriodId;
    if (!verifiedBillingPeriodId) {
      throw new Error("The current local billing cycle could not be verified.");
    }
    if (
      !subscription.billingPeriod ||
      subscription.billingPeriod.id !== verifiedBillingPeriodId ||
      subscription.billingPeriod.status !== BillingPeriodStatus.OPEN
    ) {
      throw new Error("The current local billing cycle could not be verified.");
    }
    if (!this.provider.getSubscriptionLifecycleSnapshot) {
      throw new Error("Shopify lifecycle snapshot is not supported by the billing provider");
    }
    const lifecycleSnapshot = await this.provider.getSubscriptionLifecycleSnapshot({ shopifyShopId: shop.shopifyShopId });
    let providerSubscription = executableProviderSubscription(lifecycleSnapshot);
    if (!providerSubscription && lifecycleSnapshot.latestLifecycleEvent?.state === "FROZEN") {
      throw new Error("The Shopify subscription is frozen.");
    }
    if (!providerSubscription || providerSubscription.planHandle !== plan.shopifyPlanHandle) {
      throw new Error("The recovery credit pack meter could not be verified with Shopify.");
    }
    const merchantPricingPlan = await this.readMerchantPricingPlan(providerSubscription.planHandle);
    const selectedEvent = merchantPricingPlan?.usageEvents.find((event) => event.eventHandle === eventHandle);
    let providerPackMeter = providerSubscription.usageItems.find((item) => item.handle === eventHandle);
    if (!merchantPricingPlan || !selectedEvent || !providerPackMeter || !providerSubscription.usageEventHandles.includes(eventHandle)) {
      throw new Error("The selected recovery credit offer could not be verified with Shopify.");
    }
    const creditsGranted = selectedEvent.creditsGrantedPerUnit;
    const initialProviderBeforeEvidence = providerPackMeter.usage;
    if (!hasProviderBeforeEvidence(initialProviderBeforeEvidence)) {
      throw new Error("Shopify recovery credit usage before evidence is unavailable.");
    }
    if (!hasMatchingBillingCycle(subscription, providerSubscription, verifiedBillingPeriodId)) {
      throw new Error("The current Shopify billing cycle could not be verified.");
    }
    if (deriveBillingPeriodPhase(providerSubscription.currentPeriodEnd) !== "ACTIVE") {
      throw new Error(RECOVERY_CREDIT_PACK_UNAVAILABLE_DURING_TRANSITION);
    }
    const revalidatedLifecycleSnapshot = await this.provider.getSubscriptionLifecycleSnapshot({ shopifyShopId: shop.shopifyShopId });
    const revalidatedProviderSubscription = executableProviderSubscription(revalidatedLifecycleSnapshot);
    if (
      !revalidatedProviderSubscription ||
      !sameRecoveryCreditProviderEvidence(providerSubscription, revalidatedProviderSubscription, eventHandle)
    ) {
      throw new Error("Recovery credit pack provider configuration changed during purchase request.");
    }
    providerSubscription = revalidatedProviderSubscription;
    providerPackMeter = providerSubscription.usageItems.find((item) => item.handle === eventHandle);
    if (!providerPackMeter || !hasProviderBeforeEvidence(providerPackMeter.usage)) {
      throw new Error("Shopify recovery credit usage before evidence is unavailable.");
    }
    const providerBeforeEvidence = providerPackMeter.usage;
    const providerContextIdentity = deriveShopifyProviderContextIdentity({
      providerSubscriptionId: providerSubscription.providerSubscriptionId,
      planHandle: providerSubscription.planHandle,
      currentPeriodStart: providerSubscription.currentPeriodStart,
      currentPeriodEnd: providerSubscription.currentPeriodEnd,
    });
    const currentMerchantPricingPlan = await this.readMerchantPricingPlan(providerSubscription.planHandle);
    const currentSelectedEvent = currentMerchantPricingPlan?.usageEvents.find((event) => event.eventHandle === eventHandle);
    if (!currentSelectedEvent || currentSelectedEvent.creditsGrantedPerUnit !== creditsGranted) {
      throw new Error("Recovery credit pack configuration changed during purchase request.");
    }

    try {
      return await this.database.$transaction(async (transaction) => {
      if ("$queryRaw" in transaction && typeof transaction.$queryRaw === "function") {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "billing"."Subscription"
          WHERE "shopId" = ${shopId}
          FOR UPDATE
        `);
      }
      const existing = await transaction.recoveryCreditPurchase.findUnique({
        where: { id: purchaseId },
        include: { usageEvent: true },
      });
      if (existing) {
        if (existing.shopId !== shopId) throw new Error("Recovery credit purchase belongs to another shop.");
        return existing;
      }

      const unresolved = await transaction.recoveryCreditPurchase.findFirst?.({
        where: {
          shopId,
          status: "REQUESTED",
          shopifyEventHandleSnapshot: eventHandle,
        },
        orderBy: { createdAt: "asc" },
      });
      if (unresolved) throw new Error(unresolvedPurchaseMessage());

      const currentSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        include: { plan: true, billingPeriod: true },
      });
      const currentPlan = currentSubscription?.plan;
      if (
        !currentSubscription ||
        !currentPlan ||
        (currentSubscription.status !== SubscriptionProjectionStatus.ACTIVE && currentSubscription.status !== SubscriptionProjectionStatus.TRIALING) ||
        !currentPlan.active ||
        !currentSubscription.billingPeriod ||
        currentSubscription.billingPeriod.id !== currentSubscription.billingPeriodId ||
        currentSubscription.billingPeriod.status !== BillingPeriodStatus.OPEN ||
        !hasMatchingBillingCycle(currentSubscription, providerSubscription, verifiedBillingPeriodId) ||
        deriveBillingPeriodPhase(providerSubscription.currentPeriodEnd) !== "ACTIVE" ||
        currentPlan.shopifyPlanHandle !== providerSubscription.planHandle ||
        currentSelectedEvent?.creditsGrantedPerUnit !== creditsGranted ||
        (currentPlan.kind === BillingPlanKind.PAID_METERED &&
          (!currentPlan.shopifyUsageEventHandle ||
            currentPlan.shopifyUsageEventHandle === eventHandle ||
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
          shopifyEventHandle: eventHandle,
          shopifyIdempotencyKey: createShopifyUsageIdempotencyKey(shopId, usageEventId),
        },
      });
      return transaction.recoveryCreditPurchase.create({
        data: {
          id: purchaseId,
          shopId,
          planId: currentPlan.id,
          billingPeriodId: currentSubscription.billingPeriodId as string,
          shopifyPlanHandleSnapshot: currentPlan.shopifyPlanHandle,
          shopifyEventHandleSnapshot: eventHandle,
          providerSubscriptionIdSnapshot: providerContextIdentity,
          providerUsageQuantityBeforeSnapshot: providerBeforeEvidence.quantity,
          providerUsageCostBeforeSnapshot: providerBeforeEvidence.costAmount,
          providerUsageCostCurrencyBeforeSnapshot: providerBeforeEvidence.costCurrency,
          providerPriceSnapshot: providerPackMeter.price,
          creditsGranted,
          currentAmount: 0,
          reservedAmount: 0,
          status: "REQUESTED",
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
          planId: true,
          observedShopifyPlanHandle: true,
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
      const initialPaidActivation = Boolean(
        expectedInitialSelection &&
        settings?.onboardingCompleted === false &&
        existingSubscription?.planId === null &&
        !existingSubscription.observedShopifyPlanHandle &&
        expectedInitialSelection.planKind === BillingPlanKind.PAID_METERED &&
        providerSubscription.planHandle === expectedInitialSelection.pendingShopifyPlanHandle,
      );
      if (initialPaidActivation) {
        await lockShopForInitialPaidActivation(transaction, shopId);
        const transactionalShop = await transaction.shop.findUnique({
          where: { id: shopId },
          select: { status: true },
        });
        const pendingPlan = await transaction.billingPlan.findUnique({
          where: { id: expectedInitialSelection!.pendingPlanId },
        });
        const usageMeter = pendingPlan?.shopifyUsageEventHandle?.trim() ?? "";
        const exactPlan = Boolean(
          pendingPlan &&
          pendingPlan.id === expectedInitialSelection!.pendingPlanId &&
          pendingPlan.id === existingSubscription?.pendingPlanId &&
          pendingPlan.active &&
          pendingPlan.kind === BillingPlanKind.PAID_METERED &&
          pendingPlan.shopifyPlanHandle === existingSubscription?.pendingShopifyPlanHandle &&
          pendingPlan.shopifyPlanHandle === expectedInitialSelection!.pendingShopifyPlanHandle &&
          pendingPlan.shopifyPlanHandle === providerSubscription.planHandle &&
          usageMeter &&
          providerSubscription.usageEventHandles.includes(usageMeter),
        );
        const allowance = pendingPlan?.includedRecoveryConversationAllowance;
        const validAllowance = allowance !== null && allowance !== undefined &&
          Number.isSafeInteger(allowance) && allowance >= 0;
        const validCycle = providerSubscription.currentPeriodStart !== null &&
          providerSubscription.currentPeriodEnd !== null &&
          providerSubscription.currentPeriodStart < providerSubscription.currentPeriodEnd;
        const unsupportedPaidTrial = exactPlan &&
          providerSubscription.status === "TRIALING" &&
          providerSubscription.trialEndsAt !== null &&
          providerSubscription.trialEndsAt >= now &&
          !validCycle;
        const invalidCode = !usageMeter || !providerSubscription.usageEventHandles.includes(usageMeter)
          ? "MISSING_USAGE_METER"
          : unsupportedPaidTrial
            ? "UNSUPPORTED_PAID_TRIAL"
            : null;
        if (transactionalShop?.status !== ShopStatus.ACTIVE || !exactPlan || !validAllowance || (!validCycle && !unsupportedPaidTrial)) {
          return transaction.subscription.update({
            where: { shopId },
            data: {
              status: SubscriptionProjectionStatus.SYNC_ERROR,
              planId: null,
              billingPeriodId: null,
              currentPeriodStart: null,
              currentPeriodEnd: null,
              lastSyncErrorCode: invalidCode ?? "INVALID_PAID_PLAN_CONFIGURATION",
              lastSyncErrorAt: now,
              nextReconcileAt: null,
            },
          });
        }
        if (unsupportedPaidTrial) {
          return transaction.subscription.update({
            where: { shopId },
            data: {
              status: SubscriptionProjectionStatus.SYNC_ERROR,
              planId: null,
              billingPeriodId: null,
              currentPeriodStart: null,
              currentPeriodEnd: null,
              lastSyncErrorCode: "UNSUPPORTED_PAID_TRIAL",
              lastSyncErrorAt: now,
              nextReconcileAt: null,
            },
          });
        }

        const periodStart = providerSubscription.currentPeriodStart!;
        const periodEnd = providerSubscription.currentPeriodEnd!;
        const billingPeriod = await transaction.billingPeriod.findUnique({
          where: { shopId_periodStart_periodEnd: { shopId, periodStart, periodEnd } },
        });
        const billingPeriodConflict = billingPeriod && (
          billingPeriod.status !== BillingPeriodStatus.OPEN ||
          billingPeriod.subscriptionId !== existingSubscription!.id ||
          billingPeriod.planId !== pendingPlan!.id ||
          billingPeriod.shopifyPlanHandleSnapshot !== pendingPlan!.shopifyPlanHandle ||
          billingPeriod.planNameSnapshot !== pendingPlan!.name ||
          billingPeriod.planKindSnapshot !== BillingPlanKind.PAID_METERED ||
          billingPeriod.includedRecoveryCreditsGranted !== allowance
        );
        const periodCounter = billingPeriod
          ? await transaction.billingPeriodEntitlementCounter.findUnique({
              where: { billingPeriodId_counter: { billingPeriodId: billingPeriod.id, counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS } },
            })
          : null;
        const counterConflict = periodCounter && (
          periodCounter.shopId !== shopId ||
          periodCounter.billingPeriodId !== billingPeriod!.id ||
          periodCounter.grantedQuantity !== allowance
        );
        const lifetimeCounter = await transaction.shopEntitlementCounter.findUnique({
          where: { shopId_counter: { shopId, counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS } },
        });
        const policy = lifetimeCounter
          ? null
          : await transaction.platformBillingPolicy.findUnique({ where: { id: "default" } });
        const invalidLifetimePolicy = !lifetimeCounter && (
          !policy ||
          !Number.isSafeInteger(policy.lifetimeFreeRecoveryAllowance) ||
          policy.lifetimeFreeRecoveryAllowance < 0
        );
        if (billingPeriodConflict || counterConflict || invalidLifetimePolicy) {
          return transaction.subscription.update({
            where: { shopId },
            data: {
              status: SubscriptionProjectionStatus.SYNC_ERROR,
              planId: null,
              billingPeriodId: null,
              currentPeriodStart: null,
              currentPeriodEnd: null,
              lastSyncErrorCode: "INVALID_PAID_PLAN_CONFIGURATION",
              lastSyncErrorAt: now,
              nextReconcileAt: null,
            },
          });
        }
        const committedPeriod = billingPeriod ?? await transaction.billingPeriod.create({
          data: {
            shopId,
            subscriptionId: existingSubscription!.id,
            planId: pendingPlan!.id,
            shopifyPlanHandleSnapshot: pendingPlan!.shopifyPlanHandle,
            planNameSnapshot: pendingPlan!.name,
            planKindSnapshot: BillingPlanKind.PAID_METERED,
            includedRecoveryCreditsGranted: allowance!,
            periodStart,
            periodEnd,
            status: BillingPeriodStatus.OPEN,
          },
        });
        if (!periodCounter) {
          await transaction.billingPeriodEntitlementCounter.create({
            data: {
              shopId,
              billingPeriodId: committedPeriod.id,
              counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
              grantedQuantity: allowance!,
            },
          });
        }
        if (!lifetimeCounter) {
          await transaction.shopEntitlementCounter.create({
            data: {
              shopId,
              counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS,
              grantedQuantity: policy!.lifetimeFreeRecoveryAllowance,
              committedQuantity: 0,
              reservedQuantity: 0,
              refundingQuantity: 0,
            },
          });
        }
        const nextReconcileAt = new Date(Math.max(
          now.getTime(),
          periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
        ));
        const committedSubscription = await transaction.subscription.update({
          where: { shopId },
          data: {
            planId: pendingPlan!.id,
            observedShopifyPlanHandle: providerSubscription.planHandle,
            status: SubscriptionProjectionStatus.ACTIVE,
            billingPeriodId: committedPeriod.id,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            trialEndsAt: providerSubscription.trialEndsAt,
            cancelAtPeriodEnd: providerSubscription.cancelAtPeriodEnd,
            providerSubscriptionId: providerSubscription.providerSubscriptionId,
            lastSyncedAt: now,
            lastSyncErrorCode: null,
            lastSyncErrorAt: null,
            pendingShopifyPlanHandle: null,
            pendingPlanId: null,
            pendingEffectiveAt: null,
            nextReconcileAt,
          },
        });
        await transaction.shopSettings.update({ where: { shopId }, data: { onboardingCompleted: true } });
        return committedSubscription;
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
      const initialPaidProjection = preserveInitialIntent &&
        existingSubscription?.planId === null &&
        plan?.kind === BillingPlanKind.PAID_METERED;
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
      const billingPeriod = !initialPaidProjection && providerSubscription.currentPeriodStart && providerSubscription.currentPeriodEnd
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