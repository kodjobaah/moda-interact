import { afterEach, describe, expect, it, vi } from "vitest";

import { ShopifyBillingProvider } from "../../../app/services/billing/providers/shopify-billing.provider";

const credentialSnapshot = {
  version: 1,
  organizationId: "org-1",
  accessToken: "token-1",
  appId: "app-1",
} as const;

function provider(read = vi.fn(async () => credentialSnapshot)) {
  return new ShopifyBillingProvider({ requireShopifyPartnerCredentials: read });
}

function response(activeSubscription: unknown, errors?: Array<{ message: string }>) {
  return new Response(JSON.stringify({
    data: { activeSubscription },
    errors,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function lifecycleResponse(activeSubscription: unknown, event: unknown) {
  return new Response(JSON.stringify({
    data: {
      activeSubscription,
      events: { edges: event ? [{ node: event }] : [] },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function subscription(items: unknown[], pendingUpdate: unknown = null) {
  return {
    billingPeriod: "EVERY_30_DAYS",
    cancelAtEndOfCycle: false,
    trialEndsAt: null,
    currentBillingCycle: {
      startTime: "2026-09-01T00:00:00Z",
      endTime: "2026-10-01T00:00:00Z",
    },
    items,
    pendingUpdate,
    legacySubscriptionId: "legacy-1",
  };
}

const flat = (handle: string) => ({
  handle,
  description: handle,
  price: { __typename: "FlatRatePrice", active: true, currency: "USD", amount: "10" },
  usage: null,
});

const tiered = (handle: string) => ({
  handle,
  description: handle,
  price: { __typename: "TieredPrice", active: true, currency: "USD", tiersMode: "VOLUME", tiers: [] },
  usage: { quantity: 4, cost: { amount: "2", currencyCode: "USD" } },
});

const lifecycleEvent = (state: string, eventType: string, plan: unknown = { handle: "growth", billingPeriod: "EVERY_30_DAYS" }) => ({
  __typename: "SubscriptionStatus",
  id: "event-1",
  occurredAt: "2026-09-12T12:00:00.000Z",
  eventType,
  state,
  cancelEffectiveOn: null,
  plan,
  subject: { __typename: "AppReference", id: "app-1" },
  shop: { id: "shop-1" },
});

describe("ShopifyBillingProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("identifies the flat-rate plan independently of item order and observes pending updates", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([
      tiered("message-meter"),
      flat("growth"),
    ], {
      billingPeriod: "EVERY_30_DAYS",
      items: [flat("starter")],
      legacySubscriptionId: "pending-1",
    })));

    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({
        planHandle: "growth",
        billingPeriod: "EVERY_30_DAYS",
        currentFlatRatePlan: {
          handle: "growth",
          description: "growth",
          price: { amount: "10", currency: "USD" },
        },
        usageEventHandles: ["message-meter"],
        usageItems: [{
          handle: "message-meter",
          description: "message-meter",
          price: { kind: "TIERED", active: true, currency: "USD", tiersMode: "VOLUME", tiers: [] },
          usage: { quantity: 4, costAmount: "2", costCurrency: "USD" },
        }],
        pendingPlanHandle: "starter",
        pendingFlatRatePlan: {
          handle: "starter",
          price: { amount: "10", currency: "USD" },
          effectiveAt: new Date("2026-10-01T00:00:00Z"),
        },
        pendingEffectiveAt: new Date("2026-10-01T00:00:00Z"),
        providerUsageSnapshot: [{ handle: "message-meter", quantity: 4, costAmount: "2", costCurrency: "USD" }],
      });
  });

  it("identifies the flat-rate plan when it precedes the tiered meter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([
      flat("growth"),
      tiered("message-meter"),
    ])));

    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({ planHandle: "growth", usageEventHandles: ["message-meter"] });
  });

  it("keeps returned subscription items when their prices are inactive", async () => {
    const inactiveFlat = { ...flat("growth"), price: { ...flat("growth").price, active: false } };
    const inactiveTiered = { ...tiered("credit-meter"), price: { ...tiered("credit-meter").price, active: false } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([inactiveFlat, inactiveTiered])));

    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({
        planHandle: "growth",
        usageEventHandles: ["credit-meter"],
        usageItems: [{ handle: "credit-meter", price: { active: false } }],
      });
  });

  it("returns no contract without manufacturing a plan", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(null));

    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .resolves.toBeNull();
  });

  it("surfaces Partner GraphQL failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(null, [{ message: "Partner unavailable" }]));

    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("Partner unavailable");
  });

  it("rejects duplicate active current flat-rate items", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([flat("growth"), flat("starter")])));

    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("exactly one active flat-rate");
  });

  it("rejects duplicate active pending flat-rate items", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([flat("growth")], {
      items: [flat("starter"), flat("pro")],
    })));

    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("at most one active flat-rate");
  });

  it("surfaces non-successful Partner HTTP responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("503");
  });

  it("reads the latest frozen event with the live commercial subscription in one scoped request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(lifecycleResponse(subscription([flat("growth")]), lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN")));

    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({
        activeSubscription: { planHandle: "growth" },
        latestLifecycleEvent: {
          state: "FROZEN",
          planHandle: "growth",
          billingPeriod: "EVERY_30_DAYS",
        },
      });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("activeSubscription(");
    expect(body.query).toContain("events(");
    expect(body.query).toContain("... on SubscriptionStatus");
    expect(body.query).toContain("subjectId: $appId");
    expect(body.query).toContain("shopId: $shopId");
    expect(body.query).toContain("occurredAtMin: $occurredAtMin");
    expect(body.query).toContain("occurredAtMax: $occurredAtMax");
    expect(body.query).toContain("orderBy: OCCURRED_AT_DESC");
    expect(body.query).toContain("first: 1");
    expect(body.variables).toMatchObject({
      appId: "app-1",
      shopId: "shop-1",
      eventTypes: [
        "SUBSCRIPTION_CREATED",
        "SUBSCRIPTION_UPDATED",
        "SUBSCRIPTION_CANCELLATION_SCHEDULED",
        "SUBSCRIPTION_CANCELED",
        "SUBSCRIPTION_FROZEN",
        "SUBSCRIPTION_UNFROZEN",
      ],
    });
    const occurredAtMin = Date.parse(String(body.variables.occurredAtMin));
    const occurredAtMax = Date.parse(String(body.variables.occurredAtMax));
    expect(occurredAtMax - occurredAtMin).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("preserves a frozen historical plan handle when no live subscription exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(lifecycleResponse(null, lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN", {
      handle: "growth",
      billingPeriod: "EVERY_30_DAYS",
    })));

    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({
        activeSubscription: null,
        latestLifecycleEvent: { state: "FROZEN", planHandle: "growth" },
      });
  });

  it.each([
    ["non-successful HTTP response", new Response("unavailable", { status: 503 }), "503"],
    ["GraphQL errors", response(null, [{ message: "Partner unavailable" }]), "Partner unavailable"],
  ] as const)("rejects lifecycle snapshot on %s", async (_name, result, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(result);

    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .rejects.toThrow(message);
  });

  it.each([
    ["wrong app", { subject: { __typename: "AppReference", id: "other-app" } }],
    ["wrong shop", { shop: { id: "other-shop" } }],
    ["invalid timestamp", { occurredAt: "not-a-date" }],
    ["wrong event type", { state: "FROZEN", eventType: "SUBSCRIPTION_UPDATED" }],
    ["malformed root", { __typename: "OtherEvent" }],
  ] as const)("rejects lifecycle snapshot with %s", async (_name, overrides) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(lifecycleResponse(null, {
      ...lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN"),
      ...overrides,
    }));

    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .rejects.toThrow();
  });

  it("rejects a malformed lifecycle edge and parses cancellation fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(lifecycleResponse(null, {
      ...lifecycleEvent("CANCELLATION_SCHEDULED", "SUBSCRIPTION_CANCELLATION_SCHEDULED"),
      cancelEffectiveOn: "2026-10-01",
    }));

    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({
        latestLifecycleEvent: {
          state: "CANCELLATION_SCHEDULED",
          eventType: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
          cancelEffectiveOn: "2026-10-01",
        },
      });

    fetchMock.mockResolvedValue(lifecycleResponse(null, { malformed: true }));
    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("malformed lifecycle event");
  });

  it("parses a successful unfrozen lifecycle event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(lifecycleResponse(null, lifecycleEvent("UNFROZEN", "SUBSCRIPTION_UNFROZEN")));

    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({
        latestLifecycleEvent: {
          state: "UNFROZEN",
          eventType: "SUBSCRIPTION_UNFROZEN",
        },
      });
  });

  it("parses a successful canceled lifecycle event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(lifecycleResponse(null, lifecycleEvent("CANCELED", "SUBSCRIPTION_CANCELED")));

    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({
        latestLifecycleEvent: {
          state: "CANCELED",
          eventType: "SUBSCRIPTION_CANCELED",
        },
      });
  });

  it("returns no latest event when the bounded lifecycle history is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(lifecycleResponse(null, null));

    await expect(provider().getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({ activeSubscription: null, latestLifecycleEvent: null });
  });
  it("uses one atomic Partner identity for both operations, refreshing credentials per call", async () => {
    const reader = vi.fn()
      .mockResolvedValueOnce({ version: 7, organizationId: "org-7", accessToken: "token-7", appId: "app-7", apiVersion: "2026-10" })
      .mockResolvedValueOnce({ version: 8, organizationId: "org-8", accessToken: "token-8", appId: "app-8" });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(lifecycleResponse(null, null));
    const billing = provider(reader);
    await billing.getActiveSubscription({ shopifyShopId: "shop-1" });
    await billing.getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://partners.shopify.com/org-7/api/2026-10/graphql.json");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://partners.shopify.com/org-8/api/2026-07/graphql.json");
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(first.headers).toMatchObject({ "X-Shopify-Access-Token": "token-7" });
    expect(second.headers).toMatchObject({ "X-Shopify-Access-Token": "token-8" });
    expect(JSON.parse(String(first.body)).variables.appId).toBe("app-7");
    expect(JSON.parse(String(second.body)).variables.appId).toBe("app-8");
  });

  it("fails closed for absent/revoked Partner secrets without contacting Shopify or reading process.env", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const read = vi.fn().mockRejectedValue(new Error("DISABLED"));
    const billing = provider(read);
    await expect(billing.getActiveSubscription({ shopifyShopId: "shop-1" })).rejects.toThrow("DISABLED");
    await expect(billing.getSubscriptionLifecycleSnapshot({ shopifyShopId: "shop-1" })).rejects.toThrow("DISABLED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("redacts a provider error that accidentally echoes its access token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(null, [{ message: "token-1 is rejected" }]));
    await expect(provider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("[REDACTED] is rejected");
  });

});