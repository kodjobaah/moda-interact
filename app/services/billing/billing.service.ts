import { randomUUID } from "node:crypto";

import type {
  PrismaClient,
  Subscription,
} from "@prisma/client";
import {
  BillingPeriodStatus,
  BillingPeriodEntitlementCounterKind,
  BillingPlanKind,
  EntitlementCounter,
  Prisma,
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
  BillingProvider,
  MerchantShopifyLifecycleState,
  MerchantRecoveryCapacityState,
  MerchantShopifySubscriptionState,
} from "./billing.types";

import {
  ShopifyBillingProvider,
} from "./providers/shopify-billing.provider";
import {
  deriveBillingPeriodPhase,
  ensureMappedCurrentBillingPeriodProjection,
  hasDurableBillingPeriod,
  hasMatchingBillingCycle,
} from "./billing-period-projection";

export { deriveBillingPeriodPhase };

import prisma from "../../db.server";
import {
  enqueueTranslationBestEffort,
  trustedSupportLanguageTag,
} from "../merchant-support/merchant-support.service";
import {
  BillingPlanResolutionService,
  type OperationalBillingPlanResolution,
} from "./billing-plan-resolution.service";
import { SubscriptionReadService } from "./subscription-read.service";
import { MerchantRecoveryCapacityReadService } from "./merchant-recovery-capacity-read.service";
import { MerchantBillingReadService } from "./merchant-billing-read.service";
import { INITIAL_BILLING_RETRY_DELAY_MS } from "./billing-retry-policy";
import {
  HostedPlanChangeService,
  type HostedPlanChangeReturnResult,
  type HostedPlanVerificationFence,
} from "./hosted-plan-change.service";
import {
  matchesInitialFreeActivationToken,
  SubscriptionActivationService,
} from "./subscription-activation.service";
import type {
  CompletedFreeActivation,
  FreeActivationResult,
  InitialFreeActivationToken,
} from "./subscription-activation.service";
import { lockInitialFreeActivationState } from "./subscription-locks";

export { INITIAL_BILLING_RETRY_DELAY_MS } from "./billing-retry-policy";
export type {
  CompletedFreeActivation,
  FreeActivationResult,
  InitialFreeActivationToken,
  InitialPaidActivationToken,
} from "./subscription-activation.service";
export type {
  HostedPlanChangeReturnResult,
  HostedPlanVerificationFence,
} from "./hosted-plan-change.service";

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

const RECOVERY_CREDIT_PACK_UNAVAILABLE_DURING_TRANSITION =
  "Recovery credit packs are temporarily unavailable while the current Shopify billing cycle is being confirmed.";

function isSafeNonNegativeNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY =
  "Unable to derive a durable subscription lifecycle identity.";

const RECOVERY_CREDIT_PURCHASE_INTENT = "BUY_RECOVERY_CREDIT_PACK";

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
  private readonly planResolutionService: BillingPlanResolutionService;
  private readonly subscriptionReadService: SubscriptionReadService;
  private readonly subscriptionActivationService: SubscriptionActivationService;
  private readonly hostedPlanChangeService: HostedPlanChangeService;
  private readonly recoveryCapacityReadService: MerchantRecoveryCapacityReadService;
  private readonly merchantBillingReadService: MerchantBillingReadService;

  constructor(
    private readonly provider: BillingProvider =
      new ShopifyBillingProvider(),
    private readonly database: PrismaClient = prisma,
    private readonly dispatchTranslation: TranslationDispatch =
      enqueueTranslationBestEffort,
  ) {
    this.planResolutionService = new BillingPlanResolutionService(database);
    this.subscriptionReadService = new SubscriptionReadService(provider, database);
    this.subscriptionActivationService = new SubscriptionActivationService(
      database,
      this.planResolutionService,
    );
    this.hostedPlanChangeService = new HostedPlanChangeService(database);
    this.recoveryCapacityReadService = new MerchantRecoveryCapacityReadService(
      database,
      this.planResolutionService,
    );
    this.merchantBillingReadService = new MerchantBillingReadService(
      provider,
      database,
      this.planResolutionService,
    );
  }

  private async resolveOrMaterializeBillingPlan(
    planHandle: string,
  ): Promise<OperationalBillingPlanResolution> {
    return this.planResolutionService.resolveOrMaterializeBillingPlan(planHandle);
  }

  async prepareFreeActivation(
    shopId: string,
    planHandle: string,
  ): Promise<FreeActivationResult | null> {
    return this.subscriptionActivationService.prepareFreeActivation(shopId, planHandle);
  }

  async preparePaidActivation(
    shopId: string,
    planHandle: string,
  ): Promise<FreeActivationResult | null> {
    return this.subscriptionActivationService.preparePaidActivation(shopId, planHandle);
  }

  async getSubscriptionProjection(shopId: string) {
    return this.subscriptionReadService.getSubscriptionProjection(shopId);
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
    return this.subscriptionActivationService.scheduleInitialFreeReconciliationIfCurrent({
      shopId,
      expected,
      nextReconcileAt,
      partnerErrorAt,
    });
  }

  async completeFreeActivation(
    shopId: string,
    requestedPlanHandle: string,
  ): Promise<CompletedFreeActivation | null> {
    return this.subscriptionActivationService.completeFreeActivation(shopId, requestedPlanHandle);
  }

async getSubscription(
  shopId: string,
) {
    return this.subscriptionReadService.getSubscription(shopId);
}

  async getMerchantShopifySubscriptionState(
    shopId: string,
  ): Promise<MerchantShopifySubscriptionState> {
    return this.subscriptionReadService.getMerchantShopifySubscriptionState(shopId);
  }

  async getHostedPlanVerificationFence(
    shopId: string,
  ): Promise<HostedPlanVerificationFence | null> {
    return this.hostedPlanChangeService.getHostedPlanVerificationFence(shopId);
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
    return this.hostedPlanChangeService.recordHostedPlanChangeReturn({
      shopId,
      requestedPlanHandle,
      state,
      verificationFence,
    });
  }

  async recordHostedPlanVerificationFailure(
    shopId: string,
    verificationFence: HostedPlanVerificationFence | null,
  ): Promise<{ subscriptionId: string; nextReconcileAt: Date } | null> {
    return this.hostedPlanChangeService.recordHostedPlanVerificationFailure(
      shopId,
      verificationFence,
    );
  }

  async getMerchantShopifyLifecycleState(
    shopId: string,
  ): Promise<MerchantShopifyLifecycleState> {
    return this.subscriptionReadService.getMerchantShopifyLifecycleState(shopId);
  }

  async getMerchantRecoveryCapacityState(
    shopId: string,
  ): Promise<MerchantRecoveryCapacityState> {
    return this.recoveryCapacityReadService.getMerchantRecoveryCapacityState(shopId);
  }

  async getMerchantBillingState(
    shopId: string,
    verifiedCommercialState?: MerchantShopifySubscriptionState,
  ) {
    return this.merchantBillingReadService.getMerchantBillingState(
      shopId,
      verifiedCommercialState,
    );
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
    const merchantPricingPlan = await this.planResolutionService.readMerchantPricingPlan(providerSubscription.planHandle);
    const selectedEvent = merchantPricingPlan?.usageEvents.find((event: { eventHandle: string }) => event.eventHandle === eventHandle);
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
    const currentMerchantPricingPlan = await this.planResolutionService.readMerchantPricingPlan(providerSubscription.planHandle);
    const currentSelectedEvent = currentMerchantPricingPlan?.usageEvents.find((event: { eventHandle: string }) => event.eventHandle === eventHandle);
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
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
            planId: true,
          },
        });
        if (
          expectedInitialSelection &&
          !matchesInitialFreeActivationToken(current, expectedInitialSelection)
        ) {
          return null;
        }
        const now = new Date();
        const preserveInitialIntent = Boolean(
          current &&
          current.status === SubscriptionProjectionStatus.NO_CONTRACT &&
          current.planId === null &&
          !current.observedShopifyPlanHandle &&
          current.pendingShopifyPlanHandle &&
          current.pendingPlanId &&
          current.pendingEffectiveAt &&
          current.nextReconcileAt
        );

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
            pendingShopifyPlanHandle: preserveInitialIntent ? current?.pendingShopifyPlanHandle ?? null : null,
            pendingPlanId: preserveInitialIntent ? current?.pendingPlanId ?? null : null,
            pendingEffectiveAt: preserveInitialIntent ? current?.pendingEffectiveAt ?? null : null,
            nextReconcileAt: preserveInitialIntent ? current?.nextReconcileAt ?? null : null,
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

    const resolution = await this.resolveOrMaterializeBillingPlan(providerSubscription.planHandle);
    const plan = resolution.kind === "READY" ? resolution.plan : null;
    const topUpConfiguration = await this.planResolutionService.readRecoveryCreditTopUpConfiguration(
      providerSubscription.planHandle,
    );

    const planIsUsable = resolution.kind === "READY" && resolution.plan.active;
    const paidMeterIsPresent = plan?.kind !== BillingPlanKind.PAID_METERED
      || Boolean(plan.shopifyUsageEventHandle && providerSubscription.usageEventHandles.includes(plan.shopifyUsageEventHandle));
    const paidAllowanceIsValid = plan?.kind !== BillingPlanKind.PAID_METERED
      || (
        plan.includedRecoveryConversationAllowance !== null &&
        Number.isSafeInteger(plan.includedRecoveryConversationAllowance) &&
        plan.includedRecoveryConversationAllowance >= 0
      );
    const status = resolution.kind === "UNKNOWN_CATALOGUE_PLAN"
      ? SubscriptionProjectionStatus.UNMAPPED
      : resolution.kind === "INACTIVE_OPERATIONAL_PLAN" || resolution.kind === "INVALID_CATALOGUE_PLAN"
        ? SubscriptionProjectionStatus.SYNC_ERROR
        : !paidMeterIsPresent || !paidAllowanceIsValid
          ? SubscriptionProjectionStatus.SYNC_ERROR
          : providerSubscription.status === "TRIALING"
            ? SubscriptionProjectionStatus.TRIALING
            : SubscriptionProjectionStatus.ACTIVE;
    const syncErrorCode = resolution.kind === "UNKNOWN_CATALOGUE_PLAN"
      ? "UNMAPPED_PLAN_HANDLE"
      : resolution.kind === "INACTIVE_OPERATIONAL_PLAN"
        ? "BILLING_PLAN_INACTIVE"
        : resolution.kind === "INVALID_CATALOGUE_PLAN"
          ? "INVALID_MERCHANT_PRICING_PLAN"
          : status === SubscriptionProjectionStatus.SYNC_ERROR
            ? !paidMeterIsPresent
              ? "MISSING_USAGE_METER"
              : "INVALID_INCLUDED_ALLOWANCE"
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
          billingPeriodId: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
        },
      });
      const subscriptionId = existingSubscription?.id ?? randomUUID();
      if (
        expectedInitialSelection &&
        !matchesInitialFreeActivationToken(existingSubscription, expectedInitialSelection)
      ) {
        return null;
      }
      const initialPaidActivation = Boolean(
        resolution.kind === "READY" &&
        expectedInitialSelection &&
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
        return committedSubscription;
      }
      const pendingPlan = providerSubscription.pendingPlanHandle
        ? await transaction.billingPlan.findUnique({
            where: { shopifyPlanHandle: providerSubscription.pendingPlanHandle },
            select: { id: true, active: true },
          })
        : null;
      const preserveInitialIntent = Boolean(
        existingSubscription &&
        existingSubscription.status === SubscriptionProjectionStatus.NO_CONTRACT &&
        existingSubscription.planId === null &&
        !existingSubscription.observedShopifyPlanHandle &&
        existingSubscription.pendingShopifyPlanHandle &&
        existingSubscription.pendingPlanId &&
        existingSubscription.pendingEffectiveAt &&
        existingSubscription.nextReconcileAt
      );
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
      const nextReconcileAt = plan?.kind === BillingPlanKind.FREE && topUpConfiguration.enabled
        ? providerSubscription.currentPeriodEnd
          ? new Date(Math.max(now.getTime(), providerSubscription.currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS))
          : new Date(now.getTime() + INITIAL_BILLING_RETRY_DELAY_MS)
        : null;
      const preservedNextReconcileAt = preserveInitialIntent
        ? existingSubscription?.nextReconcileAt ?? null
        : nextReconcileAt;
      const billingPeriod = !initialPaidProjection && providerSubscription.currentPeriodStart && providerSubscription.currentPeriodEnd
        ? status !== SubscriptionProjectionStatus.UNMAPPED &&
          status !== SubscriptionProjectionStatus.SYNC_ERROR &&
          plan?.active === true &&
          planIsUsable
          ? await ensureMappedCurrentBillingPeriodProjection(transaction, {
              shopId,
              subscriptionId,
              periodStart: providerSubscription.currentPeriodStart,
              periodEnd: providerSubscription.currentPeriodEnd,
              providerPlanHandle: providerSubscription.planHandle,
              plan,
            })
          : await transaction.billingPeriod.upsert({
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
      const mappedProjection = billingPeriod && "kind" in billingPeriod
        ? billingPeriod
        : null;
      const projectionConflict = mappedProjection?.kind === "CONFLICT";
      const projectedStatus = projectionConflict
        ? SubscriptionProjectionStatus.SYNC_ERROR
        : status;
      const projectedPlanId = projectionConflict
        ? existingSubscription?.planId ?? null
        : planIsUsable ? plan?.id ?? null : null;
      const projectedBillingPeriodId = projectionConflict
        ? existingSubscription?.billingPeriodId ?? null
        : mappedProjection?.kind === "READY"
          ? mappedProjection.billingPeriodId
          : billingPeriod && "id" in billingPeriod
            ? billingPeriod.id
            : null;
      const projectedPeriodStart = projectionConflict
        ? existingSubscription?.currentPeriodStart ?? null
        : providerSubscription.currentPeriodStart;
      const projectedPeriodEnd = projectionConflict
        ? existingSubscription?.currentPeriodEnd ?? null
        : providerSubscription.currentPeriodEnd;
      const projectedSyncErrorCode = projectionConflict
        ? "BILLING_PERIOD_PLAN_CONFLICT"
        : syncErrorCode;
      return transaction.subscription.upsert({
        where: { shopId },
        update: {
          planId: projectedPlanId,
          observedShopifyPlanHandle: providerSubscription.planHandle,
          status: projectedStatus,
          billingPeriodId: projectedBillingPeriodId,
          currentPeriodStart: projectedPeriodStart,
          currentPeriodEnd: projectedPeriodEnd,
          trialEndsAt: providerSubscription.trialEndsAt,
          cancelAtPeriodEnd: providerSubscription.cancelAtPeriodEnd,
          providerSubscriptionId: providerSubscription.providerSubscriptionId,
          lastSyncedAt: now,
          lastSyncErrorCode: projectedSyncErrorCode,
          lastSyncErrorAt: projectedSyncErrorCode ? now : null,
          pendingShopifyPlanHandle: preservedPendingShopifyPlanHandle,
          pendingPlanId: preservedPendingPlanId,
          pendingEffectiveAt: preservedPendingEffectiveAt,
          nextReconcileAt: preservedNextReconcileAt,
        },
        create: {
          id: subscriptionId,
          shopId,
          planId: projectedPlanId,
          observedShopifyPlanHandle: providerSubscription.planHandle,
          status: projectedStatus,
          billingPeriodId: projectedBillingPeriodId,
          currentPeriodStart: projectedPeriodStart,
          currentPeriodEnd: projectedPeriodEnd,
          trialEndsAt: providerSubscription.trialEndsAt,
          cancelAtPeriodEnd: providerSubscription.cancelAtPeriodEnd,
          providerSubscriptionId: providerSubscription.providerSubscriptionId,
          lastSyncedAt: now,
          lastSyncErrorCode: projectedSyncErrorCode,
          lastSyncErrorAt: projectedSyncErrorCode ? now : null,
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