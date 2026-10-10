import type { BillingPlan, Prisma, PrismaClient, Subscription } from "@prisma/client";
import {
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  EntitlementCounter,
  ShopStatus,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
} from "@modainteract/moda-interact-shared/billing";

import type { BillingPlanResolutionService } from "./billing-plan-resolution.service";
import type { ProviderSubscription } from "./billing.types";
import { ShopifyBillingOperationService } from "./shopify-billing-operation.service";
import { INITIAL_BILLING_RETRY_DELAY_MS } from "./billing-retry-policy";
import {
  lockInitialFreeActivationState,
  lockShopForInitialPaidActivation,
} from "./subscription-locks";

export type InitialFreeActivationToken = Readonly<{
  subscriptionId: string;
  pendingPlanId: string;
  pendingShopifyPlanHandle: string;
  pendingEffectiveAt: Date;
  nextReconcileAt: Date;
  planKind?: BillingPlanKind;
}>;

export type InitialPaidActivationToken = InitialFreeActivationToken;

type ExistingInitialPaidSubscription = {
  id: string;
  planId: string | null;
  pendingPlanId: string | null;
  pendingShopifyPlanHandle: string | null;
};

export type FreeActivationResult = {
  plan: BillingPlan;
  mode: "INITIAL" | "VERIFIED_REPLAY";
  token: InitialFreeActivationToken | null;
};

export type CompletedFreeActivation = {
  subscriptionId: string;
  nextReconcileAt: Date | null;
};

export function matchesInitialFreeActivationToken(
  subscription: {
    id: string;
    pendingPlanId: string | null;
    pendingShopifyPlanHandle: string | null;
    pendingEffectiveAt: Date | null;
    nextReconcileAt: Date | null;
  } | null,
  expected: InitialFreeActivationToken,
): boolean {
  return subscription?.id === expected.subscriptionId &&
    subscription.pendingPlanId === expected.pendingPlanId &&
    subscription.pendingShopifyPlanHandle === expected.pendingShopifyPlanHandle &&
    subscription.pendingEffectiveAt?.getTime() === expected.pendingEffectiveAt.getTime() &&
    subscription.nextReconcileAt?.getTime() === expected.nextReconcileAt.getTime();
}

export class SubscriptionActivationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly planResolutionService: BillingPlanResolutionService,
    private readonly billingOperationService: ShopifyBillingOperationService =
      new ShopifyBillingOperationService(database),
  ) {}

  async prepareFreeActivation(
    shopId: string,
    planHandle: string,
  ): Promise<FreeActivationResult | null> {
    const resolution = await this.planResolutionService.resolveOrMaterializeBillingPlan(planHandle);
    if (resolution.kind !== "READY" || resolution.plan.kind !== BillingPlanKind.FREE) return null;
    const plan = resolution.plan;

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
      const isVerifiedReplay = currentSubscription?.planId === plan.id &&
        currentSubscription.observedShopifyPlanHandle === planHandle &&
        (currentSubscription.status === SubscriptionProjectionStatus.ACTIVE ||
          currentSubscription.status === SubscriptionProjectionStatus.TRIALING);
      const isInitialActivation = !currentSubscription ||
        (currentSubscription.status === SubscriptionProjectionStatus.NO_CONTRACT &&
          currentSubscription.planId === null &&
          !currentSubscription.observedShopifyPlanHandle);
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
    const resolution = await this.planResolutionService.resolveOrMaterializeBillingPlan(planHandle);
    if (resolution.kind !== "READY" || resolution.plan.kind !== BillingPlanKind.PAID_METERED) return null;
    const plan = resolution.plan;

    const now = new Date();
    return this.database.$transaction(async (transaction) => {
      await lockInitialFreeActivationState(transaction, shopId);
      const currentSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: {
          status: true,
          planId: true,
          observedShopifyPlanHandle: true,
          lastProviderLifecycleEventId: true,
        },
      });
      const isInitialActivation = !currentSubscription ||
        (currentSubscription.status === SubscriptionProjectionStatus.NO_CONTRACT &&
          currentSubscription.planId === null &&
          !currentSubscription.observedShopifyPlanHandle);
      if (!isInitialActivation) return null;

      const subscription = await transaction.subscription.upsert({
        where: { shopId },
        update: { pendingShopifyPlanHandle: planHandle, pendingPlanId: plan.id, pendingEffectiveAt: now, nextReconcileAt: now },
        create: { shopId, status: SubscriptionProjectionStatus.NO_CONTRACT, planId: null, pendingShopifyPlanHandle: planHandle, pendingPlanId: plan.id, pendingEffectiveAt: now, nextReconcileAt: now },
      });
      if (!subscription.id || !subscription.pendingPlanId || !subscription.pendingShopifyPlanHandle || !subscription.pendingEffectiveAt || !subscription.nextReconcileAt) {
        throw new Error("Initial Paid activation token was not persisted.");
      }
      await this.billingOperationService.recordInitialPaidIntent(transaction, {
        shopId,
        subscriptionId: subscription.id,
        targetPlanHandle: planHandle,
        lifecycleEventId: currentSubscription?.lastProviderLifecycleEventId ?? null,
      });
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

    async finalizeInitialPaidActivation({
      transaction,
      shopId,
      providerSubscription,
      expected,
      existingSubscription,
      now,
    }: {
      transaction: Prisma.TransactionClient;
      shopId: string;
      providerSubscription: ProviderSubscription;
      expected: InitialPaidActivationToken;
      existingSubscription: ExistingInitialPaidSubscription;
      now: Date;
    }): Promise<Subscription> {
      await lockShopForInitialPaidActivation(transaction, shopId);
      const transactionalShop = await transaction.shop.findUnique({
        where: { id: shopId },
        select: { status: true },
      });
      const pendingPlan = await transaction.billingPlan.findUnique({
        where: { id: expected.pendingPlanId },
      });
      const usageMeter = pendingPlan?.shopifyUsageEventHandle?.trim() ?? "";
      const exactPlan = Boolean(
        pendingPlan &&
        pendingPlan.id === expected.pendingPlanId &&
        pendingPlan.id === existingSubscription.pendingPlanId &&
        pendingPlan.active &&
        pendingPlan.kind === BillingPlanKind.PAID_METERED &&
        pendingPlan.shopifyPlanHandle === existingSubscription.pendingShopifyPlanHandle &&
        pendingPlan.shopifyPlanHandle === expected.pendingShopifyPlanHandle &&
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
        billingPeriod.subscriptionId !== existingSubscription.id ||
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
        periodCounter.grantedQuantity !== allowance ||
        periodCounter.currentAllowanceQuantity !== null
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
          subscriptionId: existingSubscription.id,
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
            currentAllowanceQuantity: null,
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
      return transaction.subscription.update({
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
      if (!matchesInitialFreeActivationToken(subscription, expected)) {
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
    const topUpConfiguration = await this.planResolutionService.readRecoveryCreditTopUpConfiguration(requestedPlanHandle);
    return this.database.$transaction(async (transaction) => {
      await lockInitialFreeActivationState(transaction, shopId);
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
      const hasPendingSelection =
        subscription.pendingShopifyPlanHandle !== null ||
        subscription.pendingPlanId !== null ||
        subscription.pendingEffectiveAt !== null;

      if (
        hasPendingSelection &&
        (
        subscription.pendingShopifyPlanHandle !== requestedPlanHandle ||
        subscription.pendingPlanId !== subscription.planId ||
        !subscription.pendingEffectiveAt
        )
      ) {
        return null;
      }

      const completionNow = new Date();
      const completedNextReconcileAt = !topUpConfiguration.enabled
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
}