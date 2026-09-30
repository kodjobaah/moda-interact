export type MerchantBillingSetupPhase =
  | "AWAITING_SHOPIFY_CONFIRMATION"
  | "FINALIZING_SUBSCRIPTION";

type BillingSetupProjection = {
  status?: string | null;
  observedShopifyPlanHandle?: string | null;
  pendingShopifyPlanHandle?: string | null;
  providerSubscriptionId?: string | null;
  currentPeriodStart?: Date | string | null;
  currentPeriodEnd?: Date | string | null;
  lastSyncedAt?: Date | string | null;
} | null | undefined;

type PricingPlanSummary = {
  shopifyPlanHandle: string;
  displayName?: string | null;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function shouldShowMerchantBillingSetup(
  onboardingCompleted: boolean | null | undefined,
  subscription: BillingSetupProjection,
): boolean {
  const hasSelectionEvidence = Boolean(
    subscription?.observedShopifyPlanHandle ||
    subscription?.pendingShopifyPlanHandle ||
    subscription?.providerSubscriptionId,
  );

  if (onboardingCompleted !== true) {
    return hasSelectionEvidence;
  }

  if (!subscription) return true;

  switch (subscription.status) {
    case "ACTIVE":
    case "TRIALING":
    case "FROZEN":
      return false;
    case "NO_CONTRACT":
      return Boolean(subscription.pendingShopifyPlanHandle);
    default:
      return true;
  }
}

export function buildMerchantBillingSetupState(
  subscription: BillingSetupProjection,
  pricingCatalogue: readonly PricingPlanSummary[] = [],
) {
  const planHandle = subscription?.observedShopifyPlanHandle ??
    subscription?.pendingShopifyPlanHandle ??
    null;
  const cataloguePlan = planHandle
    ? pricingCatalogue.find((plan) => plan.shopifyPlanHandle === planHandle)
    : null;
  const providerConfirmed = Boolean(
    subscription?.providerSubscriptionId &&
    subscription?.observedShopifyPlanHandle,
  );

  return {
    phase: providerConfirmed
      ? "FINALIZING_SUBSCRIPTION" as const
      : "AWAITING_SHOPIFY_CONFIRMATION" as const,
    planHandle,
    planName: cataloguePlan?.displayName?.trim() || planHandle,
    currentPeriodStart: iso(subscription?.currentPeriodStart),
    currentPeriodEnd: iso(subscription?.currentPeriodEnd),
    lastSyncedAt: iso(subscription?.lastSyncedAt),
  };
}
