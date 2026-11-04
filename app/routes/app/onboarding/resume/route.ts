import { SubscriptionProjectionStatus } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";

import { billingService } from "@/services/billing/billing.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { persistShopifyOnboardingMilestone } from "@/services/billing/onboarding-milestone.server";
import { logBillingBoundaryFailure } from "@/services/billing/providers/shopify-billing-diagnostics.server";
import { activateInitialPendingStoreCategoryIfEligible } from "@/services/store-profile/store-category-activation.server";

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

  const form = await request.formData();
  if ([...form.keys()].some((key) =>
    key !== "expectedPendingSelectionGeneration" || form.getAll(key).length !== 1,
  )) return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });

  const generationValue = form.get("expectedPendingSelectionGeneration");
  const generation = typeof generationValue === "string" ? Number(generationValue) : NaN;
  if (!Number.isSafeInteger(generation) || generation < 0) {
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

  let activation;
  try {
    activation = await activateInitialPendingStoreCategoryIfEligible({
      shopId: shop.id,
      expectedPendingSelectionGeneration: generation,
    });
  } catch (error) {
    logBillingBoundaryFailure({
      event: "billing.initial_category_activation.failed",
      operation: "activate_initial_pending_store_category",
      stage: "onboarding_resume",
      shopId: shop.id,
      identities: { expectedPendingSelectionGeneration: String(generation) },
      error,
    });
    throw error;
  }
  if (activation.kind !== "ACTIVATED" && activation.kind !== "ALREADY_ACTIVE") {
    return Response.json(
      { ok: false, error: "CATEGORY_ACTIVATION_REQUIRED" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  await persistShopifyOnboardingMilestone(shop.id);

  return Response.json({ ok: true, onboardingCompleted: true }, {
    headers: { "Cache-Control": "no-store" },
  });
}
