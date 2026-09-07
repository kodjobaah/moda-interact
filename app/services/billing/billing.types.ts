export interface ProviderSubscription {
  provider: "SHOPIFY";

  planHandle: string;

  usageEventHandles: string[];
  pendingPlanHandle: string | null;
  pendingEffectiveAt: Date | null;

  status:
    | "TRIALING"
    | "ACTIVE";

  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;

  trialEndsAt: Date | null;

  cancelAtPeriodEnd: boolean;

  providerSubscriptionId: string | null;

  providerUsageSnapshot: ProviderUsageSnapshot[];
}

export interface ProviderUsageSnapshot {
  handle: string;
  quantity: number | null;
  costAmount: string | null;
  costCurrency: string | null;
}

export interface BillingProvider {
  getActiveSubscription(
    input: GetActiveSubscriptionInput,
  ): Promise<ProviderSubscription | null>;
}

export interface GetActiveSubscriptionInput {
  shopifyShopId: string;
}