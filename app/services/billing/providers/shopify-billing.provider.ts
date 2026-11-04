import { createDefaultShopifyPlatformConfigurationService } from "../../platform-configuration/composition.server";
import type { ShopifyPlatformConfigurationService } from "../../platform-configuration/contracts.server";
import { createShopifyBillingProviderError } from "./shopify-billing-diagnostics.server";
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

type ShopifyPrice =
  | { __typename: "FlatRatePrice"; active: boolean; currency: string | null; amount: string }
  | { __typename: "TieredPrice"; active: boolean; currency: string | null; tiersMode: string; tiers: Array<{ upTo: number | null; amountPerUnit: string; amount: string }> };

type ShopifyActiveSubscription = {
  billingPeriod: string;
  cancelAtEndOfCycle: boolean;
  trialEndsAt: string | null;
  currentBillingCycle: { startTime: string; endTime: string } | null;
  items: Array<{
    handle: string | null;
    description: string | null;
    price: ShopifyPrice | null;
    usage: { quantity: number | null; cost: { amount: string; currencyCode: string } | null } | null;
  }>;
  pendingUpdate: {
    billingPeriod: string | null;
    items: Array<{ handle: string | null; price: ShopifyPrice | null }>;
    legacySubscriptionId: string | null;
  } | null;
  legacySubscriptionId: string | null;
};

const lifecycleEventTypes: ProviderSubscriptionLifecycleEventType[] = [
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  "SUBSCRIPTION_CANCELED",
  "SUBSCRIPTION_FROZEN",
  "SUBSCRIPTION_UNFROZEN",
];

const DEFAULT_PARTNER_API_VERSION = "2026-10";
const activeSubscriptionFields = `
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
`;

const activeSubscriptionQuery = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      ${activeSubscriptionFields}
    }
  }
`;

const lifecycleSnapshotQuery = `
  query SubscriptionLifecycleSnapshot(
    $appId: ID!,
    $shopId: ID!,
    $occurredAtMin: DateTime!,
    $occurredAtMax: DateTime!,
    $eventTypes: [EventType!]
  ) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      ${activeSubscriptionFields}
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
`;

type PartnerCredentialReader = Pick<ShopifyPlatformConfigurationService, "requireShopifyPartnerCredentials">;

export class ShopifyBillingProvider implements BillingProvider {
  constructor(private readonly configuration: PartnerCredentialReader = createDefaultShopifyPlatformConfigurationService()) {}

  async getActiveSubscription({ shopifyShopId }: GetActiveSubscriptionInput): Promise<ProviderSubscription | null> {
    const operation = "get_active_subscription";
    const credentials = await requirePartnerCredentials(this.configuration, operation);
    const response = await fetchShopifyBilling(
      partnerEndpoint(credentials.organizationId, credentials.apiVersion ?? DEFAULT_PARTNER_API_VERSION),
      partnerRequest(credentials.accessToken, {
        query: activeSubscriptionQuery,
        variables: { appId: credentials.appId, shopId: shopifyShopId },
      }),
      operation,
      credentials.accessToken,
    );
    const data = await readGraphQLData(response, operation, credentials.accessToken);
    return parseActiveSubscription(data.activeSubscription, operation);
  }

  async getSubscriptionLifecycleSnapshot({ shopifyShopId }: GetActiveSubscriptionInput): Promise<ProviderSubscriptionLifecycleSnapshot> {
    const operation = "get_subscription_lifecycle_snapshot";
    const credentials = await requirePartnerCredentials(this.configuration, operation);
    const occurredAtMax = new Date();
    const occurredAtMin = new Date(occurredAtMax.getTime() - 365 * 24 * 60 * 60 * 1000);
    const response = await fetchShopifyBilling(
      partnerEndpoint(credentials.organizationId, credentials.apiVersion ?? DEFAULT_PARTNER_API_VERSION),
      partnerRequest(credentials.accessToken, {
        query: lifecycleSnapshotQuery,
        variables: {
          appId: credentials.appId,
          shopId: shopifyShopId,
          occurredAtMin: occurredAtMin.toISOString(),
          occurredAtMax: occurredAtMax.toISOString(),
          eventTypes: lifecycleEventTypes,
        },
      }),
      operation,
      credentials.accessToken,
    );
    const data = await readGraphQLData(response, operation, credentials.accessToken);
    const events = requireRecord(data.events, operation, "data.events");
    const edges = requireArray(events.edges, operation, "data.events.edges");

    return {
      activeSubscription: parseActiveSubscription(data.activeSubscription, operation),
      latestLifecycleEvent: edges.length === 0
        ? null
        : parseLifecycleEvent(edges[0], credentials.appId, shopifyShopId, operation),
    };
  }
}

function partnerEndpoint(organizationId: string, apiVersion: string): string {
  return `https://partners.shopify.com/${organizationId}/api/${apiVersion}/graphql.json`;
}

function partnerRequest(accessToken: string, body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(body),
  };
}

async function requirePartnerCredentials(configuration: PartnerCredentialReader, operation: string) {
  try {
    return await configuration.requireShopifyPartnerCredentials();
  } catch (cause) {
    const hasDatabaseCode = typeof cause === "object" && cause !== null && "code" in cause;
    throw createShopifyBillingProviderError({
      operation,
      failureKind: "CONFIGURATION",
      origin: hasDatabaseCode ? "database" : "sdk_exception",
      reasonCode: "PARTNER_CREDENTIALS_UNAVAILABLE",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

async function fetchShopifyBilling(url: string, init: RequestInit, operation: string, accessToken: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw createShopifyBillingProviderError({
      operation,
      failureKind: "TRANSPORT",
      origin: "transport",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
      sensitiveValues: [accessToken],
    });
  }
}

async function readGraphQLData(response: Response, operation: string, accessToken: string): Promise<Record<string, unknown>> {
  const providerRequestId = response.headers.get("x-request-id");
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    throw createShopifyBillingProviderError({
      operation,
      failureKind: "TRANSPORT",
      origin: "transport",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
      httpStatus: response.status,
      providerRequestId,
      sensitiveValues: [accessToken],
    });
  }

  if (!response.ok) {
    const parsedBody = parseJsonQuietly(body);
    const providerErrors = extractProviderErrors(parsedBody);
    throw createShopifyBillingProviderError({
      operation,
      failureKind: "HTTP",
      origin: "provider_response",
      message: firstProviderErrorMessage(providerErrors) ?? `Shopify Partner returned HTTP ${response.status}`,
      httpStatus: response.status,
      providerRequestId,
      providerErrors,
      ...(parsedBody === null ? { providerErrorExcerpt: body } : {}),
      sensitiveValues: [accessToken],
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch (cause) {
    const parserMessage = cause instanceof Error ? cause.message : "";
    const position = parserMessage.match(/\bposition\s+(\d+)\b/i)?.[1];
    const line = parserMessage.match(/\bline\s+(\d+)\b/i)?.[1];
    const column = parserMessage.match(/\bcolumn\s+(\d+)\b/i)?.[1];
    const location = position !== undefined
      ? ` at position ${position}`
      : line !== undefined && column !== undefined
        ? ` at line ${line} column ${column}`
        : "";
    throw createShopifyBillingProviderError({
      operation,
      failureKind: "MALFORMED_RESPONSE",
      origin: "provider_response",
      reasonCode: "INVALID_JSON_RESPONSE",
      message: "Malformed Shopify billing response at response body",
      cause,
      diagnosticCause: new SyntaxError(`Invalid JSON response${location}`),
      httpStatus: response.status,
      providerRequestId,
      sensitiveValues: [accessToken],
    });
  }

  const root = requireRecord(payload, operation, "response");
  const providerErrors = parseGraphQLErrors(root.errors, operation, "errors");
  if (providerErrors.length > 0) {
    throw createShopifyBillingProviderError({
      operation,
      failureKind: "GRAPHQL",
      origin: "provider_response",
      message: firstProviderErrorMessage(providerErrors) ?? "Shopify Partner GraphQL error",
      providerErrors,
      httpStatus: response.status,
      providerRequestId,
      sensitiveValues: [accessToken],
    });
  }

  if (!Object.prototype.hasOwnProperty.call(root, "data")) malformed(operation, "data");
  const data = requireRecord(root.data, operation, "data");
  if (!Object.prototype.hasOwnProperty.call(data, "activeSubscription")) malformed(operation, "data.activeSubscription");
  return data;
}

function parseJsonQuietly(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractProviderErrors(value: unknown): Array<{ code?: unknown; message?: unknown; details?: unknown }> {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.errors)) {
    return value.errors.slice(0, 5).map((item) => {
      if (!isRecord(item)) return {};
      const extensions = isRecord(item.extensions) ? item.extensions : {};
      return {
        ...(typeof extensions.code === "string" ? { code: extensions.code } : {}),
        ...(typeof item.message === "string" ? { message: item.message } : {}),
        ...(typeof extensions.details === "string" ? { details: extensions.details } : {}),
      };
    });
  }
  const error = value.error;
  if (typeof error === "string") return [{ message: error }];
  if (isRecord(error)) {
    return [{
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.message === "string" ? { message: error.message } : {}),
      ...(typeof error.details === "string" ? { details: error.details } : {}),
    }];
  }
  return [];
}

function firstProviderErrorMessage(errors: Array<{ message?: unknown }>): string | undefined {
  const message = errors[0]?.message;
  return typeof message === "string" ? message : undefined;
}

function parseGraphQLErrors(value: unknown, operation: string, path: string): Array<{ code?: unknown; message?: unknown; details?: unknown }> {
  if (value === undefined) return [];
  const entries = requireArray(value, operation, path);
  return entries.map((entry, index) => {
    const error = requireRecord(entry, operation, `${path}[${index}]`);
    const message = requireString(error.message, operation, `${path}[${index}].message`);
    const extensions = error.extensions === undefined
      ? null
      : requireRecord(error.extensions, operation, `${path}[${index}].extensions`);
    if (extensions && extensions.code !== undefined && typeof extensions.code !== "string") malformed(operation, `${path}[${index}].extensions.code`);
    if (extensions && extensions.details !== undefined && typeof extensions.details !== "string") malformed(operation, `${path}[${index}].extensions.details`);
    return {
      ...(typeof extensions?.code === "string" ? { code: extensions.code } : {}),
      message,
      ...(typeof extensions?.details === "string" ? { details: extensions.details } : {}),
    };
  });
}

function parseActiveSubscription(value: unknown, operation: string): ProviderSubscription | null {
  if (value === null) return null;
  const subscription = requireRecord(value, operation, "data.activeSubscription");
  const billingPeriod = requireString(subscription.billingPeriod, operation, "data.activeSubscription.billingPeriod");
  const cancelAtPeriodEnd = requireBoolean(subscription.cancelAtEndOfCycle, operation, "data.activeSubscription.cancelAtEndOfCycle");
  const trialEndsAt = parseNullableDate(subscription.trialEndsAt, operation, "data.activeSubscription.trialEndsAt");
  const cycle = subscription.currentBillingCycle === null
    ? null
    : requireRecord(subscription.currentBillingCycle, operation, "data.activeSubscription.currentBillingCycle");
  const currentPeriodStart = cycle
    ? parseRequiredDate(cycle.startTime, operation, "data.activeSubscription.currentBillingCycle.startTime")
    : null;
  const currentPeriodEnd = cycle
    ? parseRequiredDate(cycle.endTime, operation, "data.activeSubscription.currentBillingCycle.endTime")
    : null;
  const items = requireArray(subscription.items, operation, "data.activeSubscription.items")
    .map((item, index) => parseSubscriptionItem(item, operation, `data.activeSubscription.items[${index}]`));
  const pendingUpdate = subscription.pendingUpdate === null ? null : parsePendingUpdate(subscription.pendingUpdate, operation);
  const providerSubscriptionId = requireNullableString(subscription.legacySubscriptionId, operation, "data.activeSubscription.legacySubscriptionId");
  const flatRateItems = items.filter((item) => item.handle && item.price?.__typename === "FlatRatePrice");
  const tieredItems = items.filter((item) => item.handle && item.price?.__typename === "TieredPrice");
  const planHandle = flatRateItems[0]?.handle;
  if (!planHandle || flatRateItems.length !== 1) {
    malformed(operation, "data.activeSubscription.items", "Malformed Shopify billing response at data.activeSubscription.items: Active Shopify subscription must have exactly one active flat-rate plan handle");
  }
  const pendingFlatRateItems = pendingUpdate?.items.filter((item) => item.handle && item.price?.__typename === "FlatRatePrice") ?? [];
  if (pendingFlatRateItems.length > 1) {
    malformed(operation, "data.activeSubscription.pendingUpdate.items", "Malformed Shopify billing response at data.activeSubscription.pendingUpdate.items: Pending Shopify subscription update must have at most one active flat-rate plan handle");
  }

  const currentFlatRatePrice = flatRateItems[0]!.price as Extract<ShopifyPrice, { __typename: "FlatRatePrice" }>;
  const pendingFlatRatePrice = pendingFlatRateItems[0]?.price as Extract<ShopifyPrice, { __typename: "FlatRatePrice" }> | undefined;
  return {
    provider: "SHOPIFY",
    planHandle,
    billingPeriod,
    currentFlatRatePlan: {
      handle: planHandle,
      description: flatRateItems[0]!.description,
      price: { amount: currentFlatRatePrice.amount, currency: currentFlatRatePrice.currency },
    },
    pendingFlatRatePlan: pendingFlatRateItems[0] ? {
      handle: pendingFlatRateItems[0].handle!,
      price: { amount: pendingFlatRatePrice!.amount, currency: pendingFlatRatePrice!.currency },
      effectiveAt: currentPeriodEnd,
    } : null,
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
          usage: item.usage ? {
            quantity: item.usage.quantity,
            costAmount: item.usage.cost?.amount ?? null,
            costCurrency: item.usage.cost?.currencyCode ?? null,
          } : null,
        }]
      : []),
    status: trialEndsAt && trialEndsAt > new Date() ? "TRIALING" : "ACTIVE",
    currentPeriodStart,
    currentPeriodEnd,
    trialEndsAt,
    cancelAtPeriodEnd,
    providerSubscriptionId,
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

function parseSubscriptionItem(value: unknown, operation: string, path: string): ShopifyActiveSubscription["items"][number] {
  const item = requireRecord(value, operation, path);
  const handle = requireNullableString(item.handle, operation, `${path}.handle`);
  const description = requireNullableString(item.description, operation, `${path}.description`);
  const price = item.price === null ? null : parsePrice(item.price, operation, `${path}.price`);
  const usage = item.usage === null ? null : requireRecord(item.usage, operation, `${path}.usage`);
  const quantity = usage ? requireNullableNumber(usage.quantity, operation, `${path}.usage.quantity`) : null;
  const cost = usage && usage.cost !== null ? requireRecord(usage.cost, operation, `${path}.usage.cost`) : null;
  const parsedCost = cost ? {
    amount: requireString(cost.amount, operation, `${path}.usage.cost.amount`),
    currencyCode: requireString(cost.currencyCode, operation, `${path}.usage.cost.currencyCode`),
  } : null;
  return { handle, description, price, usage: usage ? { quantity, cost: parsedCost } : null };
}

function parsePendingUpdate(value: unknown, operation: string): NonNullable<ShopifyActiveSubscription["pendingUpdate"]> {
  const pending = requireRecord(value, operation, "data.activeSubscription.pendingUpdate");
  const path = "data.activeSubscription.pendingUpdate";
  const billingPeriod = requireNullableString(pending.billingPeriod, operation, `${path}.billingPeriod`);
  const items = requireArray(pending.items, operation, `${path}.items`).map((value, index) => {
    const itemPath = `${path}.items[${index}]`;
    const item = requireRecord(value, operation, itemPath);
    const handle = requireNullableString(item.handle, operation, `${itemPath}.handle`);
    const price = item.price === null ? null : parsePrice(item.price, operation, `${itemPath}.price`);
    return { handle, price };
  });
  const legacySubscriptionId = requireNullableString(pending.legacySubscriptionId, operation, `${path}.legacySubscriptionId`);
  return { billingPeriod, items, legacySubscriptionId };
}

function parsePrice(value: unknown, operation: string, path: string): ShopifyPrice {
  const price = requireRecord(value, operation, path);
  const typename = requireString(price.__typename, operation, `${path}.__typename`);
  const active = requireBoolean(price.active, operation, `${path}.active`);
  const currency = requireNullableString(price.currency, operation, `${path}.currency`);
  if (typename === "FlatRatePrice") {
    return { __typename: typename, active, currency, amount: requireString(price.amount, operation, `${path}.amount`) };
  }
  if (typename === "TieredPrice") {
    const tiers = requireArray(price.tiers, operation, `${path}.tiers`).map((value, index) => {
      const tier = requireRecord(value, operation, `${path}.tiers[${index}]`);
      return {
        upTo: requireNullableNumber(tier.upTo, operation, `${path}.tiers[${index}].upTo`),
        amountPerUnit: requireString(tier.amountPerUnit, operation, `${path}.tiers[${index}].amountPerUnit`),
        amount: requireString(tier.amount, operation, `${path}.tiers[${index}].amount`),
      };
    });
    return {
      __typename: typename,
      active,
      currency,
      tiersMode: requireString(price.tiersMode, operation, `${path}.tiersMode`),
      tiers,
    };
  }
  return malformed(operation, `${path}.__typename`);
}

function parseLifecycleEvent(value: unknown, appId: string, shopId: string, operation: string): ProviderSubscriptionLifecycleEvent {
  const edge = requireRecord(value, operation, "data.events.edges[0]");
  const event = requireRecord(edge.node, operation, "data.events.edges[0].node");
  if (event.__typename !== "SubscriptionStatus") malformed(operation, "data.events.edges[0].node.__typename", "malformed lifecycle event at data.events.edges[0].node.__typename");
  const id = requireString(event.id, operation, "data.events.edges[0].node.id");
  const occurredAt = parseRequiredDate(event.occurredAt, operation, "data.events.edges[0].node.occurredAt");
  const eventType = requireString(event.eventType, operation, "data.events.edges[0].node.eventType");
  const shop = requireRecord(event.shop, operation, "data.events.edges[0].node.shop");
  const subject = requireRecord(event.subject, operation, "data.events.edges[0].node.subject");
  if (subject.__typename !== "AppReference" || subject.id !== appId || shop.id !== shopId) malformed(operation, "data.events.edges[0].node.subject/shop");
  const state = requireString(event.state, operation, "data.events.edges[0].node.state");
  const stateToEventType: Record<string, ProviderSubscriptionLifecycleEventType> = {
    CREATED: "SUBSCRIPTION_CREATED",
    UPDATED: "SUBSCRIPTION_UPDATED",
    CANCELLATION_SCHEDULED: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
    CANCELED: "SUBSCRIPTION_CANCELED",
    FROZEN: "SUBSCRIPTION_FROZEN",
    UNFROZEN: "SUBSCRIPTION_UNFROZEN",
  };
  if (!stateToEventType[state] || eventType !== stateToEventType[state]) malformed(operation, "data.events.edges[0].node.state/eventType");
  const plan = event.plan === null || event.plan === undefined
    ? null
    : requireRecord(event.plan, operation, "data.events.edges[0].node.plan");
  return {
    id,
    eventType: stateToEventType[state]!,
    state: state as ProviderSubscriptionLifecycleState,
    occurredAt,
    cancelEffectiveOn: optionalNullableString(event.cancelEffectiveOn, operation, "data.events.edges[0].node.cancelEffectiveOn"),
    planHandle: plan ? optionalNullableString(plan.handle, operation, "data.events.edges[0].node.plan.handle") : null,
    billingPeriod: plan ? optionalNullableString(plan.billingPeriod, operation, "data.events.edges[0].node.plan.billingPeriod") : null,
  };
}

function requireRecord(value: unknown, operation: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) malformed(operation, path);
  return value;
}

function requireArray(value: unknown, operation: string, path: string): unknown[] {
  if (!Array.isArray(value)) malformed(operation, path);
  return value;
}

function requireString(value: unknown, operation: string, path: string): string {
  if (typeof value !== "string") malformed(operation, path);
  return value;
}

function requireBoolean(value: unknown, operation: string, path: string): boolean {
  if (typeof value !== "boolean") malformed(operation, path);
  return value;
}

function requireNullableString(value: unknown, operation: string, path: string): string | null {
  if (value === null) return null;
  return requireString(value, operation, path);
}

function optionalNullableString(value: unknown, operation: string, path: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, operation, path);
}

function requireNullableNumber(value: unknown, operation: string, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) malformed(operation, path);
  return value;
}

function parseNullableDate(value: unknown, operation: string, path: string): Date | null {
  if (value === null) return null;
  return parseRequiredDate(value, operation, path);
}

function parseRequiredDate(value: unknown, operation: string, path: string): Date {
  const timestamp = requireString(value, operation, path);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) malformed(operation, path);
  return date;
}

function malformed(operation: string, path: string, message?: string): never {
  throw createShopifyBillingProviderError({
    operation,
    failureKind: "MALFORMED_RESPONSE",
    origin: "provider_response",
    reasonCode: "MALFORMED_SUCCESS_RESPONSE",
    message: message ?? `Malformed Shopify billing response at ${path}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}