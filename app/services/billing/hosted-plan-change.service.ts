import type { PrismaClient } from "@prisma/client";
import { INITIAL_BILLING_RETRY_DELAY_MS } from "./billing-retry-policy";
import { lockInitialFreeActivationState } from "./subscription-locks";
import type { MerchantShopifySubscriptionState } from "./billing.types";
import { ShopifyBillingOperationService } from "./shopify-billing-operation.service";

export type HostedPlanChangeReturnResult =
  | "current"
  | "pending"
  | "mismatch"
  | "no_active"
  | "unverified";

export type HostedPlanVerificationFence = {
  id: string | null;
  updatedAt: Date | null;
  status: import("@prisma/client").SubscriptionProjectionStatus | null;
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
  providerSubscriptionId: string | null;
  lastProviderLifecycleEventId: string | null;
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
    sameFenceDate(left.lastSyncErrorAt, right.lastSyncErrorAt) &&
    left.providerSubscriptionId === right.providerSubscriptionId &&
    left.lastProviderLifecycleEventId === right.lastProviderLifecycleEventId;
}

export class HostedPlanChangeService {
  constructor(
    private readonly database: PrismaClient,
    private readonly billingOperationService: ShopifyBillingOperationService =
      new ShopifyBillingOperationService(database),
  ) {}

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
        providerSubscriptionId: true,
        lastProviderLifecycleEventId: true,
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
          providerSubscriptionId: true,
          lastProviderLifecycleEventId: true,
        },
      });

      if (!sameHostedPlanVerificationFence(current, verificationFence)) {
        return { result: "unverified", subscriptionId: current?.id ?? null, nextReconcileAt: null };
      }

      if (state.status === "NO_ACTIVE_SUBSCRIPTION") {
        if (!current) return { result: "no_active", subscriptionId: null, nextReconcileAt: null };
        await this.billingOperationService.recordHostedPlanChange(transaction, {
          shopId,
          requestedPlanHandle,
          previousPlanHandle: current.observedShopifyPlanHandle,
          providerReference: current.providerSubscriptionId ?? current.lastProviderLifecycleEventId,
          result: "no_active",
          cancelAtEndOfCycle: false,
          providerCurrentPeriodStart: null,
          providerCurrentPeriodEnd: null,
          providerPendingEffectiveAt: null,
          previousCurrentPeriodEnd: current.currentPeriodEnd,
          subscriptionId: current.id,
        });
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

      if (!current) {
        return { result, subscriptionId: null, nextReconcileAt: null };
      }

      await this.billingOperationService.recordHostedPlanChange(transaction, {
        shopId,
        requestedPlanHandle,
        previousPlanHandle: current.observedShopifyPlanHandle,
        providerReference: current.providerSubscriptionId ?? current.lastProviderLifecycleEventId,
        result,
        cancelAtEndOfCycle: provider.cancelAtEndOfCycle,
        providerCurrentPeriodStart: provider.currentPeriodStart,
        providerCurrentPeriodEnd: provider.currentPeriodEnd,
        providerPendingEffectiveAt: provider.pendingUpdate?.effectiveAt ?? null,
        previousCurrentPeriodEnd: current.currentPeriodEnd,
        subscriptionId: current.id,
      });

      if (result === "mismatch") {
        return { result, subscriptionId: current.id, nextReconcileAt: current.nextReconcileAt };
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
          providerSubscriptionId: true,
          lastProviderLifecycleEventId: true,
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
}