import { describe, expect, it } from "vitest";

import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  getMerchantNavigation,
  MERCHANT_EXPERIENCE_STATES,
  MERCHANT_SURFACES,
  resolveMerchantExperienceState,
} from "../../app/services/shop/merchant-route-access-policy";

const activeShop = { status: "ACTIVE" };

const inputFor = (state: string) => {
  if (state === "REINSTALLING") return { shop: { status: "UNINSTALLED", reinstallPendingAt: new Date() } };
  if (state === "SUPPORT_ONLY") return { shop: { status: "SUSPENDED" } };
  if (state === "SIGNED_OUT") return { shop: { status: "UNINSTALLED" } };
  if (state === "ONBOARDING") return { shop: activeShop, settings: { onboardingCompleted: false }, subscription: { status: "NO_CONTRACT" } };
  const subscription = state === "ACTIVE" ? "ACTIVE" : state;
  return { shop: activeShop, settings: { onboardingCompleted: true }, subscription: { status: subscription } };
};

describe("merchant route access policy", () => {
  it.each(MERCHANT_EXPERIENCE_STATES)("resolves %s", (state) => {
    expect(resolveMerchantExperienceState(inputFor(state))).toBe(state);
  });

  it("gives onboarding precedence over subscription state", () => {
    expect(resolveMerchantExperienceState({ shop: activeShop, settings: { onboardingCompleted: false }, subscription: { status: "ACTIVE" } })).toBe("ONBOARDING");
  });

  it("resolves missing and unmapped subscription states to billing attention", () => {
    expect(resolveMerchantExperienceState({ shop: activeShop, settings: { onboardingCompleted: true } })).toBe("BILLING_ATTENTION");
    expect(resolveMerchantExperienceState({ shop: activeShop, settings: { onboardingCompleted: true }, subscription: { status: "UNMAPPED" } })).toBe("BILLING_ATTENTION");
    expect(resolveMerchantExperienceState({ shop: activeShop, settings: { onboardingCompleted: true }, subscription: { status: "SYNC_ERROR" } })).toBe("BILLING_ATTENTION");
  });

  it.each(MERCHANT_EXPERIENCE_STATES)("has an explicit decision for every surface in %s", (state) => {
    expect(MERCHANT_SURFACES.every((surface) => typeof canAccessMerchantSurface(state, surface))).toBe(true);
  });

  it("matches the exact lifecycle matrix", () => {
    expect(MERCHANT_EXPERIENCE_STATES.flatMap((state) => MERCHANT_SURFACES.filter((surface) => canAccessMerchantSurface(state, surface)))).toEqual([
      "SUPPORT",
      "SUPPORT",
      "HOME", "BILLING_OPTIONS", "SUPPORT", "PLAN_SELECT",
      "HOME", "USAGE", "BILLING_OPTIONS", "BILLING_PURCHASE_HISTORY", "PROMOTIONS", "SUPPORT", "PLAN_SELECT", "PENDING_RECOVERIES",
      "HOME", "USAGE", "BILLING_OPTIONS", "BILLING_PURCHASE_HISTORY", "SUPPORT", "PLAN_SELECT",
      "HOME", "USAGE", "BILLING_OPTIONS", "BILLING_PURCHASE_HISTORY", "SUPPORT",
      "HOME", "USAGE", "BILLING_OPTIONS", "BILLING_PURCHASE_HISTORY", "SUPPORT", "PLAN_SELECT",
    ]);
  });

  it.each([
    ["REINSTALLING", "USAGE", "/app/reinstalling"],
    ["SUPPORT_ONLY", "BILLING_OPTIONS", "/app/merchant-support"],
    ["SIGNED_OUT", "HOME", "/auth/login"],
    ["ONBOARDING", "USAGE", "/app"],
    ["NO_CONTRACT", "PROMOTIONS", "/app"],
    ["FROZEN", "PLAN_SELECT", "/app/billing/options"],
    ["FROZEN", "PROMOTIONS", "/app"],
    ["BILLING_ATTENTION", "PENDING_RECOVERIES", "/app"],
  ] as const)("returns the denial destination for %s/%s", (state, surface, destination) => {
    expect(getMerchantDeniedRedirect(state, surface)).toBe(destination);
  });

  it("returns stable ordered navigation that never advertises a denied surface", () => {
    expect(getMerchantNavigation("ONBOARDING")).toEqual([
      { id: "home", href: "/app" },
      { id: "billing", href: "/app/billing/options" },
      { id: "messages", href: "/app/merchant-support" },
    ]);
    expect(getMerchantNavigation("ACTIVE")).toHaveLength(4);
    expect(getMerchantNavigation("SUPPORT_ONLY")).toEqual([{ id: "messages", href: "/app/merchant-support" }]);
    expect(getMerchantNavigation("REINSTALLING")).toEqual([{ id: "messages", href: "/app/merchant-support" }]);
  });

  it.each([
    ["SIGNED_OUT", []],
    ["REINSTALLING", ["/app/merchant-support"]],
    ["SUPPORT_ONLY", ["/app/merchant-support"]],
    ["ONBOARDING", ["/app", "/app/billing/options", "/app/merchant-support"]],
    ["ACTIVE", ["/app", "/app/billing/options", "/app/merchant-support", "/app/promotions"]],
    ["NO_CONTRACT", ["/app", "/app/billing/options", "/app/merchant-support"]],
    ["FROZEN", ["/app", "/app/billing/options", "/app/merchant-support"]],
    ["BILLING_ATTENTION", ["/app", "/app/billing/options", "/app/merchant-support"]],
  ] as const)("returns the complete ordered navigation for %s", (state, hrefs) => {
    expect(getMerchantNavigation(state).map((item) => item.href)).toEqual(hrefs);
    expect(getMerchantNavigation(state).every((item) => (
      item.id === "home"
        ? canAccessMerchantSurface(state, "HOME")
        : item.id === "billing"
          ? canAccessMerchantSurface(state, "BILLING_OPTIONS")
          : item.id === "promotions"
            ? canAccessMerchantSurface(state, "PROMOTIONS")
            : canAccessMerchantSurface(state, "SUPPORT")
    ))).toBe(true);
  });
});