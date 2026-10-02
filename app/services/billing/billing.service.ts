import { randomUUID } from "node:crypto";

import type {
  PrismaClient,
  Subscription,
} from "@prisma/client";
import {
  BillingPeriodStatus,
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
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
} from "./billing-period-projection";

export { deriveBillingPeriodPhase };

import prisma from "../../db.server";
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
import { RecoveryCreditPurchaseRequestService } from "./recovery-credit-purchase-request.service";
import {
  deriveLifecycleIdentity,
  defaultTranslationDispatch,
  SubscriptionEndedNotificationService,
  type TranslationDispatch,
} from "./subscription-ended-notification.service";

export { renderSubscriptionEndedMessage } from "./subscription-ended-notification.service";

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

export class BillingService {
  private readonly planResolutionService: BillingPlanResolutionService;
  private readonly subscriptionReadService: SubscriptionReadService;
  private readonly subscriptionActivationService: SubscriptionActivationService;
  private readonly hostedPlanChangeService: HostedPlanChangeService;
  private readonly recoveryCreditPurchaseRequestService: RecoveryCreditPurchaseRequestService;
  private readonly recoveryCapacityReadService: MerchantRecoveryCapacityReadService;
  private readonly merchantBillingReadService: MerchantBillingReadService;
  private readonly subscriptionEndedNotificationService: SubscriptionEndedNotificationService;

  constructor(
    private readonly provider: BillingProvider =
      new ShopifyBillingProvider(),
    private readonly database: PrismaClient = prisma,
    dispatchTranslation: TranslationDispatch =
      defaultTranslationDispatch,
  ) {
    this.planResolutionService = new BillingPlanResolutionService(database);
    this.subscriptionReadService = new SubscriptionReadService(provider, database);
    this.subscriptionActivationService = new SubscriptionActivationService(
      database,
      this.planResolutionService,
    );
    this.hostedPlanChangeService = new HostedPlanChangeService(database);
    this.recoveryCreditPurchaseRequestService = new RecoveryCreditPurchaseRequestService(
      provider,
      database,
      this.planResolutionService,
    );
    this.recoveryCapacityReadService = new MerchantRecoveryCapacityReadService(
      database,
      this.planResolutionService,
    );
    this.merchantBillingReadService = new MerchantBillingReadService(
      provider,
      database,
      this.planResolutionService,
    );
    this.subscriptionEndedNotificationService = new SubscriptionEndedNotificationService(
      database,
      dispatchTranslation,
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
    return this.recoveryCreditPurchaseRequestService.requestRecoveryCreditPack(
      shopId,
      intent,
      purchaseId,
      eventHandle,
    );
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
        await this.subscriptionEndedNotificationService.notifySubscriptionEnded(
          shopId,
          lifecycle,
        );
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
        return this.subscriptionActivationService.finalizeInitialPaidActivation({
          transaction,
          shopId,
          providerSubscription,
          expected: expectedInitialSelection!,
          existingSubscription: existingSubscription!,
          now,
        });
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