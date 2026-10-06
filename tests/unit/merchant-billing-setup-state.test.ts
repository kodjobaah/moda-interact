import { describe, expect, it } from "vitest";

import {
  buildMerchantBillingSetupState,
  shouldShowMerchantBillingSetup,
} from "../../app/services/billing/merchant-billing-setup-state";

describe("merchant billing setup state", () => {
  it("keeps a genuinely fresh install on onboarding", () => {
    expect(shouldShowMerchantBillingSetup(false, null)).toBe(false);
  });

  it("shows waiting state after a pending managed-pricing selection", () => {
    const subscription = {
      status: "NO_CONTRACT",
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: "growth",
      providerSubscriptionId: null,
    };

    expect(shouldShowMerchantBillingSetup(false, subscription)).toBe(true);
    expect(buildMerchantBillingSetupState(subscription, [
      { shopifyPlanHandle: "growth", displayName: "Growth" },
    ])).toMatchObject({
      phase: "AWAITING_SHOPIFY_CONFIRMATION",
      planHandle: "growth",
      planName: "Growth",
    });
  });

  it("shows verifying state when Shopify evidence exists but the local plan is not safely mapped", () => {
    const subscription = {
      status: "UNMAPPED",
      planId: null,
      observedShopifyPlanHandle: "free",
      pendingShopifyPlanHandle: null,
      providerSubscriptionId: "gid://shopify/AppSubscription/1",
      currentPeriodStart: new Date("2026-09-18T21:20:00.000Z"),
      currentPeriodEnd: new Date("2026-10-18T21:20:00.000Z"),
    };

    expect(shouldShowMerchantBillingSetup(true, subscription)).toBe(true);
    expect(buildMerchantBillingSetupState(subscription, [
      { shopifyPlanHandle: "free", displayName: "Free" },
    ])).toMatchObject({
      phase: "VERIFYING_SUBSCRIPTION",
      planHandle: "free",
      planName: "Free",
      currentPeriodStart: "2026-09-18T21:20:00.000Z",
      currentPeriodEnd: "2026-10-18T21:20:00.000Z",
    });
  });

  it("shows finalizing state only after the local active subscription is mapped", () => {
    const subscription = {
      status: "ACTIVE",
      planId: "plan-free",
      observedShopifyPlanHandle: "free",
      pendingShopifyPlanHandle: null,
      providerSubscriptionId: "gid://shopify/AppSubscription/1",
    };

    expect(buildMerchantBillingSetupState(subscription, [
      { shopifyPlanHandle: "free", displayName: "Free" },
    ])).toMatchObject({
      phase: "FINALIZING_SUBSCRIPTION",
      planHandle: "free",
      planName: "Free",
    });
  });

  it("leaves setup once an onboarded local projection is active", () => {
    expect(shouldShowMerchantBillingSetup(true, {
      status: "ACTIVE",
      observedShopifyPlanHandle: "growth",
      providerSubscriptionId: "gid://shopify/AppSubscription/1",
    })).toBe(false);
  });
});
