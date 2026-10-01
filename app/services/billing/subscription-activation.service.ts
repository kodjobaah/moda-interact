import type { BillingPlan, PrismaClient } from "@prisma/client";
import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";

import type { BillingPlanResolutionService } from "./billing-plan-resolution.service";
import { INITIAL_BILLING_RETRY_DELAY_MS } from "./billing-retry-policy";
import { lockInitialFreeActivationState } from "./subscription-locks";

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
        select: { status: true, planId: true, observedShopifyPlanHandle: true },
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