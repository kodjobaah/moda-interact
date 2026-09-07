import type {
  BillingProvider,
  GetActiveSubscriptionInput,
  ProviderSubscription,
} from "../billing.types";

interface ShopifyActiveSubscriptionResponse {
  data?: {
    activeSubscription: {
      billingPeriod: string;
      cancelAtEndOfCycle: boolean;
      trialEndsAt: string | null;

      currentBillingCycle: {
        startTime: string;
        endTime: string;
      } | null;

      items: Array<{
        handle: string | null;
        description: string | null;
        price: ShopifyPrice | null;
        usage: {
          quantity: number | null;
          cost: { amount: string; currencyCode: string } | null;
        } | null;
      }>;

      pendingUpdate: {
        billingPeriod: string | null;
        items: Array<{ handle: string | null; price: ShopifyPrice | null }>;
        legacySubscriptionId: string | null;
      } | null;

      legacySubscriptionId: string | null;
    } | null;
  };

  errors?: Array<{
    message: string;
  }>;
}

type ShopifyPrice =
  | { __typename: "FlatRatePrice"; active: boolean; currency: string | null; amount: string }
  | { __typename: "TieredPrice"; active: boolean; currency: string | null; tiersMode: string; tiers: Array<{ upTo: number | null; amountPerUnit: string; amount: string }> };

export class ShopifyBillingProvider
  implements BillingProvider {

  async getActiveSubscription({
    shopifyShopId,
  }: GetActiveSubscriptionInput): Promise<ProviderSubscription | null> {

    const orgId =
      process.env.SHOPIFY_PARTNER_ORG_ID;

    const accessToken =
      process.env.SHOPIFY_PARTNER_ACCESS_TOKEN;

    const appId =
      process.env.SHOPIFY_APP_ID;

    if (!orgId || !accessToken || !appId) {
      throw new Error(
        "Shopify Partner API configuration is missing",
      );
    }

    const response = await fetch(
      `https://partners.shopify.com/${orgId}/api/2026-07/graphql.json`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },

        body: JSON.stringify({
          query: `
            query ActiveSubscription(
              $appId: ID!,
              $shopId: ID!
            ) {
              activeSubscription(
                appId: $appId,
                shopId: $shopId
              ) {
                billingPeriod
                cancelAtEndOfCycle
                trialEndsAt

                currentBillingCycle {
                  startTime
                  endTime
                }

                items {
                  handle
                  description
                  price {
                    __typename
                    active
                    currency
                    ... on FlatRatePrice { amount }
                    ... on TieredPrice { tiersMode tiers { upTo amountPerUnit amount } }
                  }
                  usage { quantity cost { amount currencyCode } }
                }

                pendingUpdate {
                  billingPeriod
                  items {
                    handle
                    price {
                      __typename
                      active
                      currency
                      ... on FlatRatePrice { amount }
                      ... on TieredPrice { tiersMode tiers { upTo amountPerUnit amount } }
                    }
                  }
                  legacySubscriptionId
                }

                legacySubscriptionId
              }
            }
          `,

          variables: {
            appId,
            shopId: shopifyShopId,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Shopify billing request failed: ${response.status}`,
      );
    }

    const result =
      await response.json() as ShopifyActiveSubscriptionResponse;

    if (result.errors?.length) {
      throw new Error(
        result.errors
          .map((error) => error.message)
          .join(", "),
      );
    }

    const subscription =
      result.data?.activeSubscription;

    if (!subscription) {
      return null;
    }

    const flatRateItems = subscription.items.filter(
      (item) => item.handle && item.price?.__typename === "FlatRatePrice" && item.price.active,
    );
    const tieredItems = subscription.items.filter(
      (item) => item.handle && item.price?.__typename === "TieredPrice" && item.price.active,
    );
    const planHandle = flatRateItems[0]?.handle;

    if (!planHandle || flatRateItems.length !== 1) {
      throw new Error(
        "Active Shopify subscription must have exactly one active flat-rate plan handle",
      );
    }

    const pendingFlatRateItems = subscription.pendingUpdate?.items.filter(
      (item) => item.handle && item.price?.__typename === "FlatRatePrice" && item.price.active,
    ) ?? [];

    if (pendingFlatRateItems.length > 1) {
      throw new Error(
        "Pending Shopify subscription update must have at most one active flat-rate plan handle",
      );
    }

    const pendingPlanHandle = pendingFlatRateItems[0]?.handle ?? null;

    const trialEndsAt =
      subscription.trialEndsAt
        ? new Date(subscription.trialEndsAt)
        : null;

    const currentPeriodStart =
      subscription.currentBillingCycle
        ? new Date(
            subscription.currentBillingCycle.startTime,
          )
        : null;

    const currentPeriodEnd =
      subscription.currentBillingCycle
        ? new Date(
            subscription.currentBillingCycle.endTime,
          )
        : null;

    return {
      provider: "SHOPIFY",
      planHandle,

      status:
        trialEndsAt && trialEndsAt > new Date()
          ? "TRIALING"
          : "ACTIVE",

      currentPeriodStart,
      currentPeriodEnd,
      trialEndsAt,

      cancelAtPeriodEnd:
        subscription.cancelAtEndOfCycle,

      providerSubscriptionId:
        subscription.legacySubscriptionId,

      usageEventHandles: tieredItems.flatMap((item) => item.handle ? [item.handle] : []),
      pendingPlanHandle,
      pendingEffectiveAt: pendingPlanHandle ? currentPeriodEnd : null,
      providerUsageSnapshot: tieredItems.flatMap((item) => item.handle ? [{
        handle: item.handle,
        quantity: item.usage?.quantity ?? null,
        costAmount: item.usage?.cost?.amount ?? null,
        costCurrency: item.usage?.cost?.currencyCode ?? null,
      }] : []),
    };
  }
}