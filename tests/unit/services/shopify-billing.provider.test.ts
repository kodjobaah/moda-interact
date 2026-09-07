import { afterEach, describe, expect, it, vi } from "vitest";

import { ShopifyBillingProvider } from "../../../app/services/billing/providers/shopify-billing.provider";

const originalEnvironment = {
  orgId: process.env.SHOPIFY_PARTNER_ORG_ID,
  accessToken: process.env.SHOPIFY_PARTNER_ACCESS_TOKEN,
  appId: process.env.SHOPIFY_APP_ID,
};

function response(activeSubscription: unknown, errors?: Array<{ message: string }>) {
  return new Response(JSON.stringify({
    data: { activeSubscription },
    errors,
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

describe("ShopifyBillingProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.SHOPIFY_PARTNER_ORG_ID = originalEnvironment.orgId;
    process.env.SHOPIFY_PARTNER_ACCESS_TOKEN = originalEnvironment.accessToken;
    process.env.SHOPIFY_APP_ID = originalEnvironment.appId;
  });

  it("identifies the flat-rate plan independently of item order and observes pending updates", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "org-1";
    process.env.SHOPIFY_PARTNER_ACCESS_TOKEN = "token-1";
    process.env.SHOPIFY_APP_ID = "app-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([
      tiered("message-meter"),
      flat("growth"),
    ], {
      billingPeriod: "EVERY_30_DAYS",
      items: [flat("starter")],
      legacySubscriptionId: "pending-1",
    })));

    await expect(new ShopifyBillingProvider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({
        planHandle: "growth",
        usageEventHandles: ["message-meter"],
        pendingPlanHandle: "starter",
        pendingEffectiveAt: new Date("2026-10-01T00:00:00Z"),
        providerUsageSnapshot: [{ handle: "message-meter", quantity: 4, costAmount: "2", costCurrency: "USD" }],
      });
  });

  it("identifies the flat-rate plan when it precedes the tiered meter", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "org-1";
    process.env.SHOPIFY_PARTNER_ACCESS_TOKEN = "token-1";
    process.env.SHOPIFY_APP_ID = "app-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([
      flat("growth"),
      tiered("message-meter"),
    ])));

    await expect(new ShopifyBillingProvider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .resolves.toMatchObject({ planHandle: "growth", usageEventHandles: ["message-meter"] });
  });

  it("returns no contract without manufacturing a plan", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "org-1";
    process.env.SHOPIFY_PARTNER_ACCESS_TOKEN = "token-1";
    process.env.SHOPIFY_APP_ID = "app-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(null));

    await expect(new ShopifyBillingProvider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .resolves.toBeNull();
  });

  it("surfaces Partner GraphQL failures", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "org-1";
    process.env.SHOPIFY_PARTNER_ACCESS_TOKEN = "token-1";
    process.env.SHOPIFY_APP_ID = "app-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(null, [{ message: "Partner unavailable" }]));

    await expect(new ShopifyBillingProvider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("Partner unavailable");
  });

  it("rejects duplicate active current flat-rate items", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "org-1";
    process.env.SHOPIFY_PARTNER_ACCESS_TOKEN = "token-1";
    process.env.SHOPIFY_APP_ID = "app-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([flat("growth"), flat("starter")])));

    await expect(new ShopifyBillingProvider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("exactly one active flat-rate");
  });

  it("rejects duplicate active pending flat-rate items", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "org-1";
    process.env.SHOPIFY_PARTNER_ACCESS_TOKEN = "token-1";
    process.env.SHOPIFY_APP_ID = "app-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(subscription([flat("growth")], {
      items: [flat("starter"), flat("pro")],
    })));

    await expect(new ShopifyBillingProvider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("at most one active flat-rate");
  });

  it("surfaces non-successful Partner HTTP responses", async () => {
    process.env.SHOPIFY_PARTNER_ORG_ID = "org-1";
    process.env.SHOPIFY_PARTNER_ACCESS_TOKEN = "token-1";
    process.env.SHOPIFY_APP_ID = "app-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(new ShopifyBillingProvider().getActiveSubscription({ shopifyShopId: "shop-1" }))
      .rejects.toThrow("503");
  });
});