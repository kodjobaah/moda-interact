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
import { authenticate } from "@/shopify.server";

import {
  billingService,
  INITIAL_BILLING_RETRY_DELAY_MS,
} from "@/services/billing/billing.service";
import { enqueueBillingSubscriptionReconcileBestEffort } from "@/services/billing/billing-reconciliation.service";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";

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

export async function loader({
  request,
}: LoaderFunctionArgs) {
  const {
    admin,
    redirect,
    session,
  } = await authenticate.admin(request);

  const url = new URL(request.url);
  const requestedPlanHandle = url.searchParams.get("plan_handle");

  if (!requestedPlanHandle) {
    throw new Response("Missing plan_handle", { status: 400 });
  }

  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  assertActiveShop(shop, { route: "/app/billing/callback", capability: "sync-billing", redirectTo: "/app/merchant-support" });

  const activation = await billingService.prepareFreeActivation(shop.id, requestedPlanHandle) ??
    await billingService.preparePaidActivation(shop.id, requestedPlanHandle);

  if (activation) {
    let partnerVerificationSucceeded = false;
    let partnerErrorAt: Date | null = null;
    let syncedSubscription: BillingCallbackSubscription | null = null;
    try {
      syncedSubscription = await billingService.syncSubscription(shop.id, activation.token ?? undefined) as BillingCallbackSubscription | null;
      partnerVerificationSucceeded = true;
    } catch {
      partnerErrorAt = new Date();
    }

    const subscription = activation.plan.kind === "PAID_METERED"
      ? syncedSubscription
      : await billingService.getSubscriptionProjection(shop.id);
    const expectedPlanKind = activation.plan.kind === "PAID_METERED" ? "PAID_METERED" : "FREE";

    if (partnerVerificationSucceeded && expectedPlanKind === "PAID_METERED" && isVerifiedPaidActivation(subscription, requestedPlanHandle, activation.plan.id)) {
      await enqueueBillingSubscriptionReconcileBestEffort({
        shopId: shop.id,
        subscriptionId: subscription!.id,
        expectedNextReconcileAt: subscription!.nextReconcileAt!,
      });
      return redirect("/app");
    }

    if (partnerVerificationSucceeded && expectedPlanKind === "FREE" && subscription && isVerifiedBillingCallback(subscription, requestedPlanHandle, expectedPlanKind)) {
      const completed = await billingService.completeFreeActivation(shop.id, requestedPlanHandle);
      if (completed?.nextReconcileAt) {
        await enqueueBillingSubscriptionReconcileBestEffort({
          shopId: shop.id,
          subscriptionId: completed.subscriptionId,
          expectedNextReconcileAt: completed.nextReconcileAt,
        });
      }
      return redirect("/app");
    }

    if (activation.mode !== "INITIAL" || !activation.token) {
      return redirect("/app");
    }

    if (expectedPlanKind === "PAID_METERED" && syncedSubscription?.lastSyncErrorCode) {
      return redirect("/app");
    }

    const nextReconcileAt = new Date(Date.now() + INITIAL_BILLING_RETRY_DELAY_MS);
    const pending = await billingService.scheduleInitialFreeReconciliationIfCurrent({
      shopId: shop.id,
      expected: activation.token,
      nextReconcileAt,
      partnerErrorAt,
    });
    if (pending) {
      await enqueueBillingSubscriptionReconcileBestEffort({
        shopId: shop.id,
        subscriptionId: pending.subscriptionId,
        expectedNextReconcileAt: pending.nextReconcileAt,
      });
    }
    return redirect("/app");
  }

  let verification;
  try {
    verification = await billingService.getMerchantShopifySubscriptionState(shop.id);
  } catch {
    const retry = await billingService.recordHostedPlanVerificationFailure(shop.id);
    if (retry) {
      await enqueueBillingSubscriptionReconcileBestEffort({
        shopId: shop.id,
        subscriptionId: retry.subscriptionId,
        expectedNextReconcileAt: retry.nextReconcileAt,
      });
    }
    return redirect("/app/billing/options?plan_change=unverified");
  }

  const result = await billingService.recordHostedPlanChangeReturn({
    shopId: shop.id,
    requestedPlanHandle,
    state: verification,
  });
  if (result.subscriptionId && result.nextReconcileAt && result.result !== "mismatch") {
    await enqueueBillingSubscriptionReconcileBestEffort({
      shopId: shop.id,
      subscriptionId: result.subscriptionId,
      expectedNextReconcileAt: result.nextReconcileAt,
    });
  }

  return redirect(`/app/billing/options?plan_change=${result.result}`);
}

export default function BillingCallback() {
  return null;
}
