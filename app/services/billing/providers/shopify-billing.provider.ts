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
      }>;

      legacySubscriptionId: string | null;
    } | null;
  };

  errors?: Array<{
    message: string;
  }>;
}

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

    /*
     * For a simple fixed-plan setup, the recurring
     * subscription item handle is our plan handle.
     *
     * Later, if you have multiple usage-meter items,
     * we can explicitly distinguish plan items from
     * event-meter handles.
     */
    const planHandle =
      subscription.items
        .map((item) => item.handle)
        .find(
          (handle): handle is string =>
            Boolean(handle),
        );

    if (!planHandle) {
      throw new Error(
        "Active Shopify subscription has no plan handle",
      );
    }

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
    };
  }
}