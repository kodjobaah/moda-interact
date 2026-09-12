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
> & {
  plan: Pick<BillingPlan, "kind" | "shopifyPlanHandle"> | null;
};

export function isVerifiedBillingCallback(
  subscription: BillingCallbackSubscription | null,
  requestedPlanHandle: string | null,
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
    subscription.plan?.kind === "FREE";

  const pendingSelectionConflicts = subscription.pendingShopifyPlanHandle !== null && (
    subscription.pendingShopifyPlanHandle !== requestedPlanHandle ||
    subscription.pendingPlanId !== subscription.planId ||
    subscription.pendingEffectiveAt === null
  );

  return currentPlanMatches && !pendingSelectionConflicts;
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

  const requestedPlanHandle =
    url.searchParams.get("plan_handle");

  if (!requestedPlanHandle) {
    throw new Response(
      "Missing plan_handle",
      { status: 400 },
    );
  }

  const shop =
    await shopService.resolveShopifyShop({
      admin,
      domain: session.shop,
    });
  assertActiveShop(shop, { route: "/app/billing/callback", capability: "sync-billing", redirectTo: "/app/merchant-support" });

  const activation = await billingService.prepareFreeActivation(shop.id, requestedPlanHandle);
  if (!activation) return redirect("/app");

  let partnerVerificationSucceeded = false;
  let partnerErrorAt: Date | null = null;
  try {
    await billingService.syncSubscription(shop.id, activation.token ?? undefined);
    partnerVerificationSucceeded = true;
  } catch {
    partnerErrorAt = new Date();
  }

  const subscription = await billingService.getSubscriptionProjection(shop.id);
  if (partnerVerificationSucceeded && subscription && isVerifiedBillingCallback(subscription, requestedPlanHandle)) {
    const completed = await billingService.completeFreeActivation(shop.id, requestedPlanHandle);
    if (completed?.nextReconcileAt) {
      await enqueueBillingSubscriptionReconcileBestEffort({
        shopId: shop.id,
        subscriptionId: completed.subscriptionId,
        expectedNextReconcileAt: completed.nextReconcileAt,
      });
    }
    if (completed) return redirect("/app");
  }

  if (activation.mode !== "INITIAL" || !activation.token) {
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

  return redirect(
    "/app",
  );
}


export default function BillingCallback() {
  return null;
}