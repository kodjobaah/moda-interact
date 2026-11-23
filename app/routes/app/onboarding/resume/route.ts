import { SubscriptionProjectionStatus } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";

import { billingService } from "@/services/billing/billing.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { persistShopifyOnboardingMilestone } from "@/services/billing/onboarding-milestone.server";
import { logBillingBoundaryFailure } from "@/services/billing/providers/shopify-billing-diagnostics.server";

const ACTIVE_STATUSES = new Set<SubscriptionProjectionStatus>([
  SubscriptionProjectionStatus.ACTIVE,
  SubscriptionProjectionStatus.TRIALING,
]);

export async function action({ request, context }: ActionFunctionArgs) {
  const { shop } = await getMerchantRequestContext({ request, context });
  assertActiveShop(shop, {
    route: "/app/onboarding/resume",
    redirectTo: "/app/merchant-support",
  });

  if (shop.onboardingCompleted === true) {
    return Response.json({ ok: true, onboardingCompleted: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // No initial store category or selection generation is required for billing.
  const form = await request.formData();
  if ([...form.keys()].length !== 0) {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }

  const projection = await billingService.getSubscriptionProjection(shop.id);
  const hasExistingShopifyEvidence = Boolean(
    projection?.providerSubscriptionId ||
    projection?.observedShopifyPlanHandle ||
    projection?.pendingShopifyPlanHandle,
  );
  if (!hasExistingShopifyEvidence) {
    return Response.json(
      { ok: false, error: "BILLING_RECONCILIATION_REQUIRED" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  let subscription;
  try {
    subscription = await billingService.syncSubscription(shop.id);
  } catch (error) {
    logBillingBoundaryFailure({
      event: "billing.onboarding_resume.sync_failed",
      operation: "sync_subscription_for_onboarding_resume",
      stage: "provider_or_projection",
      shopId: shop.id,
      error,
    });
    return Response.json(
      { ok: false, error: "BILLING_RECONCILIATION_FAILED" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (
    !subscription ||
    !ACTIVE_STATUSES.has(subscription.status) ||
    subscription.planId === null
  ) {
    return Response.json(
      { ok: false, error: "BILLING_RECONCILIATION_REQUIRED" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  await persistShopifyOnboardingMilestone(shop.id);

  return Response.json({ ok: true, onboardingCompleted: true }, {
    headers: { "Cache-Control": "no-store" },
  });
}
