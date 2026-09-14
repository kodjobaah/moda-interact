import type {
  LoaderFunctionArgs,
} from "react-router";
import { authenticate } from "@/shopify.server";

import {
  billingService,
} from "@/services/billing/billing.service";
import { enqueueBillingSubscriptionReconcileBestEffort } from "@/services/billing/billing-reconciliation.service";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";

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