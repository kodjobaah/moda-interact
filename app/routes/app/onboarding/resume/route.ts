import { SubscriptionProjectionStatus } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "@/shopify.server";
import { billingService } from "@/services/billing/billing.service";
import db from "@/db.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { activateInitialPendingStoreCategoryIfEligible } from "@/services/store-profile/store-category-activation.server";

const ACTIVE_STATUSES = new Set<SubscriptionProjectionStatus>([
  SubscriptionProjectionStatus.ACTIVE,
  SubscriptionProjectionStatus.TRIALING,
]);

async function persistOnboardingMilestone(shopId: string): Promise<void> {
  await db.$transaction(async (transaction) => {
    const shop = await transaction.shop.updateMany({
      where: { id: shopId },
      data: { onboardingCompleted: true },
    });
    if (shop.count !== 1) {
      throw new Error(`Unable to mark onboarding complete for Shop ${shopId}`);
    }

    const settings = await transaction.shopSettings.updateMany({
      where: { shopId },
      data: { onboardingCompleted: true },
    });
    if (settings.count !== 1) {
      throw new Error(`ShopSettings invariant missing for Shop ${shopId}`);
    }
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
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
  } catch {
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

  const activation = await activateInitialPendingStoreCategoryIfEligible({
    shopId: shop.id,
    expectedPendingSelectionGeneration: generation,
  });
  if (activation.kind !== "ACTIVATED" && activation.kind !== "ALREADY_ACTIVE") {
    return Response.json(
      { ok: false, error: "CATEGORY_ACTIVATION_REQUIRED" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  await persistOnboardingMilestone(shop.id);

  return Response.json({ ok: true, onboardingCompleted: true }, {
    headers: { "Cache-Control": "no-store" },
  });
}
