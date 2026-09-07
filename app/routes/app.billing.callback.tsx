import type {
  LoaderFunctionArgs,
} from "react-router";
import {
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type {
  Subscription,
} from "@prisma/client";

import { authenticate } from "../shopify.server";

import {
  billingService,
} from "../services/billing/billing.service";
import { shopService } from "../services/shop/shop.service";

type BillingCallbackSubscription = Pick<
  Subscription,
  | "status"
  | "observedShopifyPlanHandle"
  | "planId"
  | "pendingShopifyPlanHandle"
  | "pendingPlanId"
  | "pendingEffectiveAt"
>;

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
    subscription.planId !== null;
  const pendingPlanMatches =
    subscription.pendingShopifyPlanHandle === requestedPlanHandle &&
    subscription.pendingPlanId !== null &&
    subscription.pendingEffectiveAt !== null;

  return currentPlanMatches || pendingPlanMatches;
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

  const subscription =
    await billingService.syncSubscription(
      shop.id,
    );

  if (!isVerifiedBillingCallback(subscription, requestedPlanHandle)) {
    return redirect(
      "/app/billing?billing=inactive",
    );
  }

  return redirect(
    "/app/billing?billing=success",
  );
}


export default function BillingCallback() {
  return null;
}