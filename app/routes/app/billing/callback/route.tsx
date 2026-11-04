import type {
  LoaderFunctionArgs,
} from "react-router";
import {
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type {
  BillingPlan,
  Subscription,
} from "@prisma/client";
import {
  billingService,
  INITIAL_BILLING_RETRY_DELAY_MS,
} from "@/services/billing/billing.service";
import { enqueueBillingSubscriptionReconcileBestEffort } from "@/services/billing/billing-reconciliation.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { persistShopifyOnboardingMilestone } from "@/services/billing/onboarding-milestone.server";
import {
  classifyBillingVerificationFailure,
  logBillingBoundaryFailure,
} from "@/services/billing/providers/shopify-billing-diagnostics.server";
import { enqueueSubscriptionActivatedDiscountSyncBestEffort } from "@/services/discounts/shopify-discount-lifecycle.service";
import { activateInitialPendingStoreCategoryIfEligible } from "@/services/store-profile/store-category-activation.server";

function billingOptionsRedirect(result: string, requestedPlanHandle: string) {
  const params = new URLSearchParams({ plan_change: result });
  if (result === "mismatch" || result === "unverified") {
    params.set("requested_plan_handle", requestedPlanHandle);
  }
  return `/app/billing/options?${params.toString()}`;
}

type BillingCallbackSubscription = Pick<
  Subscription,
  | "id"
  | "status"
  | "observedShopifyPlanHandle"
  | "planId"
  | "pendingShopifyPlanHandle"
  | "pendingPlanId"
  | "pendingEffectiveAt"
  | "nextReconcileAt"
  | "billingPeriodId"
  | "currentPeriodStart"
  | "currentPeriodEnd"
  | "lastSyncErrorCode"
  | "providerSubscriptionId"
> & {
  plan: Pick<BillingPlan, "kind" | "shopifyPlanHandle"> | null;
};

export function isVerifiedBillingCallback(
  subscription: BillingCallbackSubscription | null,
  requestedPlanHandle: string | null,
  expectedPlanKind: "FREE" | "PAID_METERED" = "FREE",
): boolean {
  if (!subscription || !requestedPlanHandle) return false;

  const activeProjectionStatuses: SubscriptionProjectionStatus[] = [
    SubscriptionProjectionStatus.ACTIVE,
    SubscriptionProjectionStatus.TRIALING,
  ];
  if (!activeProjectionStatuses.includes(subscription.status)) return false;

  const currentPlanMatches =
    subscription.observedShopifyPlanHandle === requestedPlanHandle &&
    subscription.planId !== null &&
    subscription.plan?.kind === expectedPlanKind;

  const pendingSelectionConflicts = subscription.pendingShopifyPlanHandle !== null && (
    subscription.pendingShopifyPlanHandle !== requestedPlanHandle ||
    subscription.pendingPlanId !== subscription.planId ||
    subscription.pendingEffectiveAt === null
  );

  return currentPlanMatches && !pendingSelectionConflicts;
}


function isVerifiedPaidActivation(
  subscription: BillingCallbackSubscription | null,
  requestedPlanHandle: string,
  planId: string,
): boolean {
  return Boolean(
    subscription &&
    subscription.status === SubscriptionProjectionStatus.ACTIVE &&
    subscription.planId === planId &&
    subscription.observedShopifyPlanHandle === requestedPlanHandle &&
    subscription.billingPeriodId &&
    subscription.currentPeriodStart &&
    subscription.currentPeriodEnd &&
    subscription.pendingShopifyPlanHandle === null &&
    subscription.pendingPlanId === null &&
    subscription.pendingEffectiveAt === null &&
    subscription.nextReconcileAt,
  );
}

async function activateInitialCategoryAfterSubscriptionCommit(
  shopId: string,
  subscription: Pick<Subscription, "status" | "planId"> | null,
): Promise<void> {
  if (
    subscription?.planId !== null &&
    subscription?.planId !== undefined &&
    (subscription.status === SubscriptionProjectionStatus.ACTIVE ||
      subscription.status === SubscriptionProjectionStatus.TRIALING)
  ) {
    try {
      await activateInitialPendingStoreCategoryIfEligible({ shopId });
    } catch (error) {
      logBillingBoundaryFailure({
        event: "billing.initial_category_activation.failed",
        operation: "activate_initial_pending_store_category",
        stage: "after_subscription_commit",
        shopId,
        identities: { subscriptionStatus: subscription.status },
        error,
      });
      throw error;
    }
  }
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs) {
  const merchantContext = await getMerchantRequestContext({ request, context });
  const { redirect } = merchantContext.authentication;
  const { shop } = merchantContext;
  assertActiveShop(shop, { route: "/app/billing/callback", capability: "sync-billing", redirectTo: "/app/merchant-support" });

  const url = new URL(request.url);
  const requestedPlanHandle = url.searchParams.get("plan_handle");

  if (!requestedPlanHandle) {
    throw new Response("Missing plan_handle", { status: 400 });
  }

  let verificationFence;
  try {
    verificationFence = await billingService.getHostedPlanVerificationFence(shop.id);
  } catch (error) {
    logBillingBoundaryFailure({
      event: "billing.hosted_plan_verification_fence.read_failed",
      operation: "read_hosted_plan_verification_fence",
      stage: "verification_fence_read",
      origin: "database",
      shopId: shop.id,
      error,
    });
    throw error;
  }
  let verification;
  try {
    verification = await billingService.getMerchantShopifySubscriptionState(shop.id);
  } catch (error) {
    const verificationFailure = classifyBillingVerificationFailure(error);
    let retry;
    try {
      retry = await billingService.recordHostedPlanVerificationFailure(shop.id, verificationFence, verificationFailure);
    } catch (retryError) {
      logBillingBoundaryFailure({
        event: "billing.hosted_plan_verification_retry.persist_failed",
        operation: "record_hosted_plan_verification_failure",
        stage: "fenced_retry_persistence",
        origin: "database",
        shopId: shop.id,
        identities: { subscriptionId: verificationFence?.id ?? null },
        error: retryError,
      });
      throw retryError;
    }
    if (retry) {
      await enqueueBillingSubscriptionReconcileBestEffort({
        shopId: shop.id,
        subscriptionId: retry.subscriptionId,
        expectedNextReconcileAt: retry.nextReconcileAt,
      });
    }
    return redirect(billingOptionsRedirect("unverified", requestedPlanHandle));
  }

  const providerConfirmsSelection = verification.status === "ACTIVE_SUBSCRIPTION" && (
    verification.subscription?.planHandle === requestedPlanHandle ||
    verification.subscription?.pendingUpdate?.planHandle === requestedPlanHandle
  );
  if (!providerConfirmsSelection) {
    let result;
    try {
      result = await billingService.recordHostedPlanChangeReturn({
        shopId: shop.id,
        requestedPlanHandle,
        state: verification,
        verificationFence,
      });
    } catch (error) {
      logBillingBoundaryFailure({
        event: "billing.hosted_plan_change_return.persist_failed",
        operation: "record_hosted_plan_change_return",
        stage: "fenced_hosted_return_persistence",
        origin: "database",
        shopId: shop.id,
        identities: { subscriptionId: verificationFence?.id ?? null },
        error,
      });
      throw error;
    }
    if (
      result.subscriptionId &&
      result.nextReconcileAt &&
      ["current", "pending", "no_active"].includes(result.result)
    ) {
      await enqueueBillingSubscriptionReconcileBestEffort({
        shopId: shop.id,
        subscriptionId: result.subscriptionId,
        expectedNextReconcileAt: result.nextReconcileAt,
      });
    }
    return redirect(billingOptionsRedirect(result.result, requestedPlanHandle));
  }

  await persistShopifyOnboardingMilestone(shop.id);

  let activation;
  try {
    activation = await billingService.prepareFreeActivation(shop.id, requestedPlanHandle);
  } catch (error) {
    logBillingBoundaryFailure({
      event: "billing.subscription_activation.prepare_failed",
      operation: "prepare_free_subscription_activation",
      stage: "activation_prepare",
      origin: "database",
      shopId: shop.id,
      identities: { requestedPlanHandle },
      error,
    });
    throw error;
  }
  if (!activation) {
    try {
      activation = await billingService.preparePaidActivation(shop.id, requestedPlanHandle);
    } catch (error) {
      logBillingBoundaryFailure({
        event: "billing.subscription_activation.prepare_failed",
        operation: "prepare_paid_subscription_activation",
        stage: "activation_prepare",
        origin: "database",
        shopId: shop.id,
        identities: { requestedPlanHandle },
        error,
      });
      throw error;
    }
  }

  if (activation) {
    let partnerVerificationSucceeded = false;
    let verificationFailure: ReturnType<typeof classifyBillingVerificationFailure> | null = null;
    let syncedSubscription: BillingCallbackSubscription | null = null;
    try {
      syncedSubscription = await billingService.syncSubscription(shop.id, activation.token ?? undefined) as BillingCallbackSubscription | null;
      partnerVerificationSucceeded = true;
    } catch (error) {
      verificationFailure = classifyBillingVerificationFailure(error);
    }

    const subscription = activation.plan.kind === "PAID_METERED"
      ? syncedSubscription
      : await billingService.getSubscriptionProjection(shop.id);
    const expectedPlanKind = activation.plan.kind === "PAID_METERED" ? "PAID_METERED" : "FREE";

    if (partnerVerificationSucceeded && expectedPlanKind === "PAID_METERED" && isVerifiedPaidActivation(subscription, requestedPlanHandle, activation.plan.id)) {
      await activateInitialCategoryAfterSubscriptionCommit(shop.id, subscription);
      await enqueueBillingSubscriptionReconcileBestEffort({
        shopId: shop.id,
        subscriptionId: subscription!.id,
        expectedNextReconcileAt: subscription!.nextReconcileAt!,
      });
      await enqueueSubscriptionActivatedDiscountSyncBestEffort(shop.id);
      return redirect("/app");
    }

    if (partnerVerificationSucceeded && expectedPlanKind === "FREE" && subscription && isVerifiedBillingCallback(subscription, requestedPlanHandle, expectedPlanKind)) {
      let completed;
      try {
        completed = await billingService.completeFreeActivation(shop.id, requestedPlanHandle);
      } catch (error) {
        logBillingBoundaryFailure({
          event: "billing.subscription_activation.complete_failed",
          operation: "complete_free_subscription_activation",
          stage: "activation_finalize",
          origin: "database",
          shopId: shop.id,
          identities: { requestedPlanHandle, subscriptionId: activation.token?.subscriptionId ?? null },
          error,
        });
        throw error;
      }
      if (completed) await activateInitialCategoryAfterSubscriptionCommit(shop.id, subscription);
      if (completed?.nextReconcileAt) {
        await enqueueBillingSubscriptionReconcileBestEffort({
          shopId: shop.id,
          subscriptionId: completed.subscriptionId,
          expectedNextReconcileAt: completed.nextReconcileAt,
        });
      }
      await enqueueSubscriptionActivatedDiscountSyncBestEffort(shop.id);
      return redirect("/app");
    }

    if (activation.mode !== "INITIAL" || !activation.token) {
      return redirect("/app");
    }

    if (expectedPlanKind === "PAID_METERED" && syncedSubscription?.lastSyncErrorCode) {
      return redirect("/app");
    }

    const nextReconcileAt = new Date(Date.now() + INITIAL_BILLING_RETRY_DELAY_MS);
    let pending;
    try {
      pending = await billingService.scheduleInitialFreeReconciliationIfCurrent({
        shopId: shop.id,
        expected: activation.token,
        nextReconcileAt,
        verificationFailure,
      });
    } catch (error) {
      logBillingBoundaryFailure({
        event: "billing.initial_activation_retry.persist_failed",
        operation: "schedule_initial_free_reconciliation",
        stage: "fenced_retry_persistence",
        origin: "database",
        shopId: shop.id,
        identities: { subscriptionId: activation.token.subscriptionId },
        error,
      });
      throw error;
    }
    if (pending) {
      await enqueueBillingSubscriptionReconcileBestEffort({
        shopId: shop.id,
        subscriptionId: pending.subscriptionId,
        expectedNextReconcileAt: pending.nextReconcileAt,
      });
    }
    return redirect("/app");
  }

  const freshInitialProjection = (
    verificationFence === null ||
    (
      verificationFence.status === SubscriptionProjectionStatus.NO_CONTRACT &&
      verificationFence.planId === null &&
      verificationFence.observedShopifyPlanHandle === null
    )
  ) && verification.status === "ACTIVE_SUBSCRIPTION" &&
    verification.subscription?.planHandle === requestedPlanHandle;
  if (freshInitialProjection) {
    const subscription = await billingService.syncSubscription(shop.id);
    await activateInitialCategoryAfterSubscriptionCommit(shop.id, subscription);
    return redirect("/app");
  }

  const result = await billingService.recordHostedPlanChangeReturn({
    shopId: shop.id,
    requestedPlanHandle,
    state: verification,
    verificationFence,
  });
  if (
    result.subscriptionId &&
    result.nextReconcileAt &&
    ["current", "pending", "no_active"].includes(result.result)
  ) {
    await enqueueBillingSubscriptionReconcileBestEffort({
      shopId: shop.id,
      subscriptionId: result.subscriptionId,
      expectedNextReconcileAt: result.nextReconcileAt,
    });
  }

  return redirect(billingOptionsRedirect(result.result, requestedPlanHandle));
}

export default function BillingCallback() {
  return null;
}
