import type {
  BillingProvider,
  GetActiveSubscriptionInput,
  ProviderSubscription,
  ProviderSubscriptionLifecycleEvent,
  ProviderSubscriptionLifecycleEventType,
  ProviderSubscriptionLifecycleSnapshot,
  ProviderSubscriptionLifecycleState,
  ProviderUsageItem,
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

interface ShopifyLifecycleSnapshotResponse extends ShopifyActiveSubscriptionResponse {
  data?: ShopifyActiveSubscriptionResponse["data"] & {
    events?: { edges?: unknown[] };
  };
}

type ShopifyPrice =
  | { __typename: "FlatRatePrice"; active: boolean; currency: string | null; amount: string }
  | { __typename: "TieredPrice"; active: boolean; currency: string | null; tiersMode: string; tiers: Array<{ upTo: number | null; amountPerUnit: string; amount: string }> };

const lifecycleEventTypes: ProviderSubscriptionLifecycleEventType[] = [
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  "SUBSCRIPTION_CANCELED",
  "SUBSCRIPTION_FROZEN",
  "SUBSCRIPTION_UNFROZEN",
];

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
    const currentFlatRatePrice = flatRateItems[0]?.price?.__typename === "FlatRatePrice"
      ? flatRateItems[0].price
      : null;
    const pendingFlatRatePrice = pendingFlatRateItems[0]?.price?.__typename === "FlatRatePrice"
      ? pendingFlatRateItems[0].price
      : null;

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
      billingPeriod: subscription.billingPeriod,
      currentFlatRatePlan: {
        handle: planHandle,
        description: flatRateItems[0]?.description ?? null,
        price: {
          amount: currentFlatRatePrice?.amount ?? "",
          currency: currentFlatRatePrice?.currency ?? null,
        },
      },
      pendingFlatRatePlan: pendingFlatRateItems[0]
        ? {
            handle: pendingPlanHandle as string,
            price: {
              amount: pendingFlatRatePrice?.amount ?? "",
              currency: pendingFlatRatePrice?.currency ?? null,
            },
            effectiveAt: currentPeriodEnd,
          }
        : null,
      usageItems: tieredItems.flatMap((item): ProviderUsageItem[] => item.handle && item.price?.__typename === "TieredPrice"
        ? [{
            handle: item.handle,
            description: item.description,
            price: {
              kind: "TIERED",
              active: item.price.active,
              currency: item.price.currency,
              tiersMode: item.price.tiersMode,
              tiers: item.price.tiers,
            },
            usage: item.usage
              ? {
                  quantity: item.usage.quantity,
                  costAmount: item.usage.cost?.amount ?? null,
                  costCurrency: item.usage.cost?.currencyCode ?? null,
                }
              : null,
          }]
        : []),

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

  async getSubscriptionLifecycleSnapshot({
    shopifyShopId,
  }: GetActiveSubscriptionInput): Promise<ProviderSubscriptionLifecycleSnapshot> {
    const orgId = process.env.SHOPIFY_PARTNER_ORG_ID;
    const accessToken = process.env.SHOPIFY_PARTNER_ACCESS_TOKEN;
    const appId = process.env.SHOPIFY_APP_ID;

    if (!orgId || !accessToken || !appId) {
      throw new Error("Shopify Partner API configuration is missing");
    }

    const occurredAtMax = new Date();
    const occurredAtMin = new Date(occurredAtMax.getTime() - 365 * 24 * 60 * 60 * 1000);
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
            query SubscriptionLifecycleSnapshot(
              $appId: ID!,
              $shopId: ID!,
              $occurredAtMin: DateTime!,
              $occurredAtMax: DateTime!,
              $eventTypes: [EventType!]
            ) {
              activeSubscription(appId: $appId, shopId: $shopId) {
                billingPeriod
                cancelAtEndOfCycle
                trialEndsAt
                currentBillingCycle { startTime endTime }
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
              events(
                first: 1
                filter: {
                  subjectId: $appId
                  shopId: $shopId
                  eventTypes: $eventTypes
                  occurredAtMin: $occurredAtMin
                  occurredAtMax: $occurredAtMax
                }
                orderBy: OCCURRED_AT_DESC
              ) {
                edges {
                  node {
                    __typename
                    id
                    occurredAt
                    eventType
                    shop { id }
                    subject { __typename ... on AppReference { id } }
                    ... on SubscriptionStatus {
                      state
                      cancelEffectiveOn
                      plan { handle billingPeriod }
                    }
                  }
                }
              }
            }
          `,
          variables: {
            appId,
            shopId: shopifyShopId,
            occurredAtMin: occurredAtMin.toISOString(),
            occurredAtMax: occurredAtMax.toISOString(),
            eventTypes: lifecycleEventTypes,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Shopify billing request failed: ${response.status}`);
    }
    const result = await response.json() as ShopifyLifecycleSnapshotResponse;
    if (result.errors?.length) {
      throw new Error(result.errors.map((error) => error.message).join(", "));
    }
    if (!result.data || !Object.prototype.hasOwnProperty.call(result.data, "activeSubscription") ||
      !result.data.events || !Array.isArray(result.data.events.edges)) {
      throw new Error("Shopify Partner API returned a malformed lifecycle snapshot");
    }

    return {
      activeSubscription: parseLifecycleActiveSubscription(result.data.activeSubscription),
      latestLifecycleEvent: result.data.events.edges.length === 0
        ? null
        : parseLifecycleEvent(result.data.events.edges[0], appId, shopifyShopId),
    };
  }
}

function parseLifecycleActiveSubscription(
  subscription: NonNullable<ShopifyActiveSubscriptionResponse["data"]>["activeSubscription"] | null,
): ProviderSubscription | null {
  if (!subscription) return null;
  const flatRateItems = subscription.items.filter(
    (item) => item.handle && item.price?.__typename === "FlatRatePrice" && item.price.active,
  );
  const tieredItems = subscription.items.filter(
    (item) => item.handle && item.price?.__typename === "TieredPrice" && item.price.active,
  );
  const planHandle = flatRateItems[0]?.handle;
  if (!planHandle || flatRateItems.length !== 1) {
    throw new Error("Active Shopify subscription must have exactly one active flat-rate plan handle");
  }
  const pendingFlatRateItems = subscription.pendingUpdate?.items.filter(
    (item) => item.handle && item.price?.__typename === "FlatRatePrice" && item.price.active,
  ) ?? [];
  if (pendingFlatRateItems.length > 1) {
    throw new Error("Pending Shopify subscription update must have at most one active flat-rate plan handle");
  }
  const currentFlatRatePrice = flatRateItems[0]?.price?.__typename === "FlatRatePrice" ? flatRateItems[0].price : null;
  const pendingFlatRatePrice = pendingFlatRateItems[0]?.price?.__typename === "FlatRatePrice" ? pendingFlatRateItems[0].price : null;
  const trialEndsAt = subscription.trialEndsAt ? new Date(subscription.trialEndsAt) : null;
  const currentPeriodStart = subscription.currentBillingCycle ? new Date(subscription.currentBillingCycle.startTime) : null;
  const currentPeriodEnd = subscription.currentBillingCycle ? new Date(subscription.currentBillingCycle.endTime) : null;

  return {
    provider: "SHOPIFY",
    planHandle,
    billingPeriod: subscription.billingPeriod,
    currentFlatRatePlan: {
      handle: planHandle,
      description: flatRateItems[0]?.description ?? null,
      price: { amount: currentFlatRatePrice?.amount ?? "", currency: currentFlatRatePrice?.currency ?? null },
    },
    pendingFlatRatePlan: pendingFlatRateItems[0] ? {
      handle: pendingFlatRateItems[0].handle as string,
      price: { amount: pendingFlatRatePrice?.amount ?? "", currency: pendingFlatRatePrice?.currency ?? null },
      effectiveAt: currentPeriodEnd,
    } : null,
    usageItems: tieredItems.flatMap((item): ProviderUsageItem[] => item.handle && item.price?.__typename === "TieredPrice" ? [{
      handle: item.handle,
      description: item.description,
      price: { kind: "TIERED", active: item.price.active, currency: item.price.currency, tiersMode: item.price.tiersMode, tiers: item.price.tiers },
      usage: item.usage ? { quantity: item.usage.quantity, costAmount: item.usage.cost?.amount ?? null, costCurrency: item.usage.cost?.currencyCode ?? null } : null,
    }] : []),
    status: trialEndsAt && trialEndsAt > new Date() ? "TRIALING" : "ACTIVE",
    currentPeriodStart,
    currentPeriodEnd,
    trialEndsAt,
    cancelAtPeriodEnd: subscription.cancelAtEndOfCycle,
    providerSubscriptionId: subscription.legacySubscriptionId,
    usageEventHandles: tieredItems.flatMap((item) => item.handle ? [item.handle] : []),
    pendingPlanHandle: pendingFlatRateItems[0]?.handle ?? null,
    pendingEffectiveAt: pendingFlatRateItems[0] ? currentPeriodEnd : null,
    providerUsageSnapshot: tieredItems.flatMap((item) => item.handle ? [{
      handle: item.handle,
      quantity: item.usage?.quantity ?? null,
      costAmount: item.usage?.cost?.amount ?? null,
      costCurrency: item.usage?.cost?.currencyCode ?? null,
    }] : []),
  };
}

function parseLifecycleEvent(value: unknown, appId: string, shopId: string): ProviderSubscriptionLifecycleEvent {
  if (!isRecord(value) || !isRecord(value.node)) throw new Error("Shopify Partner API returned a malformed lifecycle event");
  const event = value.node;
  if (event.__typename !== "SubscriptionStatus" || typeof event.id !== "string" || !event.id.trim() ||
    typeof event.occurredAt !== "string" || typeof event.eventType !== "string" || !isRecord(event.subject) || !isRecord(event.shop) ||
    event.subject.__typename !== "AppReference" || event.subject.id !== appId || event.shop.id !== shopId) {
    throw new Error("Shopify Partner API returned a malformed lifecycle event");
  }
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw new Error("Shopify Partner API returned an invalid lifecycle event timestamp");
  const stateToEventType: Record<string, ProviderSubscriptionLifecycleEventType> = {
    CREATED: "SUBSCRIPTION_CREATED",
    UPDATED: "SUBSCRIPTION_UPDATED",
    CANCELLATION_SCHEDULED: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
    CANCELED: "SUBSCRIPTION_CANCELED",
    FROZEN: "SUBSCRIPTION_FROZEN",
    UNFROZEN: "SUBSCRIPTION_UNFROZEN",
  };
  const state = event.state as ProviderSubscriptionLifecycleState;
  if (!stateToEventType[state] || event.eventType !== stateToEventType[state]) {
    throw new Error("Shopify Partner API returned an invalid subscription lifecycle state");
  }
  const plan = event.plan;
  if (plan !== null && plan !== undefined && !isRecord(plan)) throw new Error("Shopify Partner API returned an invalid lifecycle plan");
  return {
    id: event.id,
    eventType: stateToEventType[state],
    state,
    occurredAt,
    cancelEffectiveOn: nullableString(event.cancelEffectiveOn),
    planHandle: nullableString(plan?.handle),
    billingPeriod: nullableString(plan?.billingPeriod),
  };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Shopify Partner API returned an invalid lifecycle field");
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}