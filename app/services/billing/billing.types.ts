export interface ProviderFlatRatePlan {
  handle: string;
  description: string | null;
  price: {
    amount: string;
    currency: string | null;
  };
}

export interface ProviderPendingFlatRatePlan {
  handle: string;
  price: {
    amount: string;
    currency: string | null;
  };
  effectiveAt: Date | null;
}

export interface ProviderUsageItem {
  handle: string;
  description: string | null;
  price: {
    kind: "TIERED";
    active: boolean;
    currency: string | null;
    tiersMode: string;
    tiers: Array<{
      upTo: number | null;
      amountPerUnit: string;
      amount: string;
    }>;
  };
  usage: {
    quantity: number | null;
    costAmount: string | null;
    costCurrency: string | null;
  } | null;
}

export interface ProviderSubscription {
  provider: "SHOPIFY";

  planHandle: string;
  billingPeriod: string;
  currentFlatRatePlan: ProviderFlatRatePlan;
  pendingFlatRatePlan: ProviderPendingFlatRatePlan | null;
  usageItems: ProviderUsageItem[];

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

export type ProviderSubscriptionLifecycleEventType =
  | "SUBSCRIPTION_CREATED"
  | "SUBSCRIPTION_UPDATED"
  | "SUBSCRIPTION_CANCELLATION_SCHEDULED"
  | "SUBSCRIPTION_CANCELED"
  | "SUBSCRIPTION_FROZEN"
  | "SUBSCRIPTION_UNFROZEN";

export type ProviderSubscriptionLifecycleState =
  | "CREATED"
  | "UPDATED"
  | "CANCELLATION_SCHEDULED"
  | "CANCELED"
  | "FROZEN"
  | "UNFROZEN";

export interface ProviderSubscriptionLifecycleEvent {
  id: string;
  eventType: ProviderSubscriptionLifecycleEventType;
  state: ProviderSubscriptionLifecycleState;
  occurredAt: Date;
  cancelEffectiveOn: string | null;
  planHandle: string | null;
  billingPeriod: string | null;
}

export interface ProviderSubscriptionLifecycleSnapshot {
  activeSubscription: ProviderSubscription | null;
  latestLifecycleEvent: ProviderSubscriptionLifecycleEvent | null;
}

export interface BillingProvider {
  getActiveSubscription(
    input: GetActiveSubscriptionInput,
  ): Promise<ProviderSubscription | null>;

  getSubscriptionLifecycleSnapshot?(
    input: GetActiveSubscriptionInput,
  ): Promise<ProviderSubscriptionLifecycleSnapshot>;
}

export interface GetActiveSubscriptionInput {
  shopifyShopId: string;
}

export type MerchantShopifySubscriptionState =
  | {
      status: "NO_ACTIVE_SUBSCRIPTION";
      subscription: null;
    }
  | {
      status: "ACTIVE_SUBSCRIPTION";
      subscription: {
        planHandle: string;
        description: string | null;
        price: {
          amount: string;
          currency: string | null;
        };
        billingPeriod: string;
        currentPeriodStart: string | null;
        currentPeriodEnd: string | null;
        trialEndsAt: string | null;
        cancelAtEndOfCycle: boolean;
        pendingUpdate: {
          planHandle: string;
          price: {
            amount: string;
            currency: string | null;
          };
          effectiveAt: string | null;
        } | null;
        usageItems: ProviderUsageItem[];
      };
      modaMapping: {
        id: string;
        name: string;
        kind: "FREE" | "PAID_METERED";
      } | null;
      mappingStatus: "MAPPED" | "UNMAPPED";
      pendingModaMapping: {
        id: string;
        name: string;
        kind: "FREE" | "PAID_METERED";
      } | null;
    };

export type MerchantShopifyLifecycleState =
  | {
      state: "ACTIVE";
      subscription: MerchantShopifySubscriptionState & { status: "ACTIVE_SUBSCRIPTION" };
      latestEvent: ProviderSubscriptionLifecycleEvent | null;
    }
  | {
      state: "FROZEN";
      subscription: MerchantShopifySubscriptionState | null;
      latestEvent: ProviderSubscriptionLifecycleEvent;
      providerPlanHandle: string | null;
      billingPeriod: string | null;
      modaMapping: Extract<MerchantShopifySubscriptionState, { status: "ACTIVE_SUBSCRIPTION" }>["modaMapping"];
      mappingStatus: "MAPPED" | "UNMAPPED";
    }
  | {
      state: "CANCELED";
      subscription: null;
      latestEvent: ProviderSubscriptionLifecycleEvent;
    }
  | {
      state: "UNRESOLVED";
      subscription: MerchantShopifySubscriptionState | null;
      latestEvent: ProviderSubscriptionLifecycleEvent | null;
    }
  | {
      state: "NO_ACTIVE_SUBSCRIPTION";
      subscription: null;
      latestEvent: null;
    };