export type MerchantBillingSetupPhase =
  | "AWAITING_SHOPIFY_CONFIRMATION"
  | "VERIFYING_SUBSCRIPTION"
  | "FINALIZING_SUBSCRIPTION";

type BillingSetupProjection = {
  status?: string | null;
  observedShopifyPlanHandle?: string | null;
  pendingShopifyPlanHandle?: string | null;
  providerSubscriptionId?: string | null;
  planId?: string | null;
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
  const providerEvidence = Boolean(
    subscription?.providerSubscriptionId &&
    subscription?.observedShopifyPlanHandle,
  );
  const mappedActiveSubscription = Boolean(
    providerEvidence &&
    subscription?.planId &&
    (subscription?.status === "ACTIVE" || subscription?.status === "TRIALING"),
  );

  return {
    phase: mappedActiveSubscription
      ? "FINALIZING_SUBSCRIPTION" as const
      : providerEvidence
        ? "VERIFYING_SUBSCRIPTION" as const
        : "AWAITING_SHOPIFY_CONFIRMATION" as const,
    planHandle,
    planName: cataloguePlan?.displayName?.trim() || planHandle,
    currentPeriodStart: iso(subscription?.currentPeriodStart),
    currentPeriodEnd: iso(subscription?.currentPeriodEnd),
    lastSyncedAt: iso(subscription?.lastSyncedAt),
  };
}
