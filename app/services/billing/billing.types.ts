export interface ProviderSubscription {
  provider: "SHOPIFY";

  planHandle: string;

  status:
    | "TRIALING"
    | "ACTIVE";

  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;

  trialEndsAt: Date | null;

  cancelAtPeriodEnd: boolean;

  providerSubscriptionId: string | null;
}

export interface BillingProvider {
  getActiveSubscription(
    input: GetActiveSubscriptionInput,
  ): Promise<ProviderSubscription | null>;
}

export interface GetActiveSubscriptionInput {
  shopifyShopId: string;
}