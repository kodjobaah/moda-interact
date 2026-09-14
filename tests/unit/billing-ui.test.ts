import { createElement, type ReactNode } from "react";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLoaderData } from "react-router";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>(
    "react-router",
  );
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: ReactNode }) =>
      createElement("a", { href: to }, children),
    useFetcher: vi.fn(() => ({ data: null, state: "idle" })),
    useLoaderData: vi.fn(),
  };
});

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const getMerchantBillingState = vi.fn();
const getMerchantRecoveryCapacityState = vi.fn();
const getSubscriptionProjection = vi.fn();
const getMerchantShopifySubscriptionState = vi.fn();
const getMerchantShopifyLifecycleState = vi.fn();
const requestRecoveryCreditPack = vi.fn();
const findShopSettings = vi.fn();
const hostedPricingRedirect = vi.fn();
const billingRouteSource = await readFile(
  new URL("../../app/routes/app/billing/route.tsx", import.meta.url),
  "utf8",
);
const billingCallbackSource = await readFile(
  new URL("../../app/routes/app/billing/callback/route.tsx", import.meta.url),
  "utf8",
);
const billingSelectSource = await readFile(
  new URL("../../app/routes/app/billing/select/route.jsx", import.meta.url),
  "utf8",
);
const billingOptionsRouteSource = await readFile(
  new URL("../../app/routes/app/billing/options/route.tsx", import.meta.url),
  "utf8",
);
const billingPurchaseHubSource = await readFile(
  new URL(
    "../../app/components/dashboard/BillingPurchaseHub.jsx",
    import.meta.url,
  ),
  "utf8",
);

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../app/services/billing/billing.service", () => ({
  billingService: {
    getMerchantBillingState,
    getMerchantRecoveryCapacityState,
    getSubscriptionProjection,
    getMerchantShopifySubscriptionState,
    getMerchantShopifyLifecycleState,
    requestRecoveryCreditPack,
  },
}));
vi.mock("../../app/db.server", () => ({
  default: { shopSettings: { findUnique: findShopSettings } },
}));

const { default: BillingRoute, loader } =
  await import("../../app/routes/app/billing/route");
const { loader: billingSelectLoader } =
  await import("../../app/routes/app/billing/select/route");
const { action: billingAction } = await import("../../app/routes/app/billing/route");
const { action: billingOptionsAction } =
  await import("../../app/routes/app/billing/options/route");
const { getMerchantSystemMessageAction } =
  await import("../../app/services/merchant-support/system-message-actions");

const useLoaderDataMock = vi.mocked(useLoaderData);
const renderBillingRoute = (overrides: Record<string, unknown> = {}) => {
  useLoaderDataMock.mockReturnValue({
    merchantUi: { locale: "en-GB", fallbackLocale: "en", timeZone: "UTC" },
    subscription: {
      status: "ACTIVE",
      planKind: "FREE",
      planName: "Free",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      pendingPlanName: null,
      pendingEffectiveAt: null,
    },
    allowance: 10,
    remaining: 10,
    paidIncluded: null,
    paidConfigurationUnavailable: false,
    lifetimeFree: {
      grantedQuantity: 10,
      committedQuantity: 0,
      reservedQuantity: 0,
      remaining: 10,
    },
    usageQuantity: 0,
    purchasedRecoveryCredits: {
      grantedQuantity: 0,
      committedQuantity: 0,
      reservedQuantity: 0,
      refundingQuantity: 0,
      available: 0,
    },
    recoveryCreditPackEnabled: true,
    recoveryCreditsPerPack: 10,
    recoveryCreditPackMeter: "credit-pack-meter",
    recoveryCreditPackMeterVerified: true,
    recoveryCreditPackPurchaseEligible: true,
    billingPeriodPhase: "ACTIVE",
    lifecycleRestriction: "AVAILABLE",
    purchaseId: "purchase-1",
    ...overrides,
  } as never);
  return renderToStaticMarkup(createElement(BillingRoute));
};

const activeFreeSubscription = {
  status: "ACTIVE",
  plan: { kind: "FREE", name: "Free" },
  observedShopifyPlanHandle: "free",
  currentPeriodStart: null,
  currentPeriodEnd: null,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  pendingPlan: null,
  pendingEffectiveAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    admin: { id: "admin-1" },
    session: { shop: "merchant.myshopify.com", locale: "en-GB" },
    redirect: hostedPricingRedirect,
  });
  resolveShopifyShop.mockResolvedValue({ id: "shop-1", status: "ACTIVE" });
  findShopSettings.mockResolvedValue(null);
  getMerchantRecoveryCapacityState.mockResolvedValue({ availability: "CONTRACT_REQUIRED" });
  getSubscriptionProjection.mockResolvedValue(null);
  getMerchantShopifySubscriptionState.mockResolvedValue({ status: "NO_ACTIVE_SUBSCRIPTION", subscription: null });
  getMerchantShopifyLifecycleState.mockResolvedValue({ state: "NO_ACTIVE_SUBSCRIPTION", subscription: null, latestEvent: null });
});

describe("merchant billing UI", () => {
  it("composes production billing authority without mock or local plan fallbacks", () => {
    expect(billingOptionsRouteSource).toContain(
      "getMerchantShopifySubscriptionState(shop.id)",
    );
    expect(billingOptionsRouteSource).toContain(
      "getMerchantRecoveryCapacityState(shop.id)",
    );
    expect(billingOptionsRouteSource).toContain(
      "getMerchantShopifyLifecycleState(shop.id)",
    );
    expect(billingOptionsRouteSource).toContain(
      "getMerchantBillingState(shop.id)",
    );
    expect(billingOptionsRouteSource).toContain(
      'managePlansHref="/app/billing/select"',
    );
    expect(billingOptionsRouteSource).not.toContain("fetch(");
    expect(billingPurchaseHubSource).not.toContain("billing-purchase.mock");
    expect(billingPurchaseHubSource).not.toContain("plans[0]");
    expect(billingPurchaseHubSource).toContain("TopUpPurchasePanel");
    expect(billingPurchaseHubSource).toContain("SubscriptionChangePanel");
  });

  it("returns the billing summary for a no-contract merchant", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: { status: "NO_CONTRACT" },
      allowance: null,
      committed: 0,
      remaining: null,
      usageQuantity: 0,
    });

    const result = await loader({
      request: new Request("https://example.test/app/billing"),
    } as never);

    expect(result.subscription).toMatchObject({ status: "NO_CONTRACT" });
    expect(hostedPricingRedirect).not.toHaveBeenCalled();
  });

  it("fails closed for a scheduled cancellation before creating a top-up", async () => {
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "AVAILABLE",
      canStartRecovery: true,
    });
    getSubscriptionProjection.mockResolvedValue({
      cancelAtPeriodEnd: true,
      pendingPlan: null,
    });

    await expect(billingAction({
      request: new Request("https://example.test/app/billing", { method: "POST", body: "" }),
    } as never)).rejects.toThrow("Shopify billing is restricted");
    expect(requestRecoveryCreditPack).not.toHaveBeenCalled();
  });

  it("hides top-up while scheduled cancellation keeps Shopify plan management", () => {
    const markup = renderBillingRoute({
      subscription: {
        ...activeFreeSubscription,
        cancelAtPeriodEnd: true,
        pendingPlanName: null,
        pendingEffectiveAt: null,
      },
    });

    expect(markup).toContain('href="/app/billing/select"');
    expect(markup).not.toContain("<form");
  });

  it("hides top-up and plan management while capacity is frozen", () => {
    const markup = renderBillingRoute({
      lifecycleRestriction: "CONTRACT_FROZEN",
    });

    expect(markup).not.toContain("<form");
    expect(markup).not.toContain('href="/app/billing/select"');
  });

  it("fails closed for a frozen capacity projection", async () => {
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "CONTRACT_FROZEN",
      canStartRecovery: false,
    });
    getSubscriptionProjection.mockResolvedValue(null);

    await expect(billingAction({
      request: new Request("https://example.test/app/billing", { method: "POST", body: "" }),
    } as never)).rejects.toThrow("Shopify billing is restricted");
    expect(requestRecoveryCreditPack).not.toHaveBeenCalled();
  });

  it("fails closed for an effective no-contract options action", async () => {
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "CONTRACT_REQUIRED",
      canStartRecovery: false,
    });
    getMerchantShopifyLifecycleState.mockResolvedValue({
      state: "NO_ACTIVE_SUBSCRIPTION",
      subscription: null,
      latestEvent: null,
    });
    getMerchantShopifySubscriptionState.mockResolvedValue({
      status: "NO_ACTIVE_SUBSCRIPTION",
      subscription: null,
    });

    await expect(billingOptionsAction({
      request: new Request("https://example.test/app/billing/options", { method: "POST", body: "" }),
    } as never)).rejects.toThrow("Shopify billing is restricted");
    expect(requestRecoveryCreditPack).not.toHaveBeenCalled();
  });

  it("redirects the selection route to Shopify pricing with a top-level target", async () => {
    process.env.SHOPIFY_APP_HANDLE = "moda-interact";
    hostedPricingRedirect.mockReturnValue({ type: "redirect" });

    await expect(
      billingSelectLoader({
        request: new Request("https://example.test/app/billing/select"),
      } as never),
    ).resolves.toEqual({ type: "redirect" });

    expect(hostedPricingRedirect).toHaveBeenCalledWith(
      "https://admin.shopify.com/store/merchant/charges/moda-interact/pricing_plans",
      { target: "_top" },
    );
  });

  it("blocks pricing selection while reinstall reconciliation is pending", async () => {
    resolveShopifyShop.mockResolvedValue({
      id: "shop-1",
      status: "UNINSTALLED",
      reinstallPendingAt: new Date("2026-09-14T00:00:00.000Z"),
    });

    await expect(billingSelectLoader({
      request: new Request("https://example.test/app/billing/select"),
    } as never)).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(Response);
      expect(error.headers.get("Location")).toBe("/app/reinstalling");
      return true;
    });
    expect(hostedPricingRedirect).not.toHaveBeenCalled();
  });

  it("keeps merchant billing surfaces out of the Admin application", () => {
    expect(`${billingRouteSource}\n${billingCallbackSource}\n${billingSelectSource}`).not.toContain(
      "moda-interact-admin",
    );
  });

  it("returns Free allowance and pending plan state without changing current plan", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: {
        ...activeFreeSubscription,
        pendingPlan: { name: "Basic" },
        pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      allowance: 7,
      committed: 3,
      remaining: 4,
      usageQuantity: 3,
    });

    const result = await loader({
      request: new Request("https://example.test/app/billing"),
    } as never);

    expect(result.subscription).toMatchObject({
      status: "ACTIVE",
      planKind: "FREE",
      planName: "Free",
      pendingPlanName: "Basic",
      pendingEffectiveAt: "2026-10-01T00:00:00.000Z",
    });
    expect(result).toMatchObject({
      allowance: 7,
      remaining: 4,
      usageQuantity: 3,
    });
  });

  it("keeps the paid entitlement current while presenting a pending Free downgrade", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: {
        status: "ACTIVE",
        plan: { kind: "PAID_METERED", name: "Growth" },
        observedShopifyPlanHandle: "growth",
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        pendingPlan: { kind: "FREE", name: "Free" },
        pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      allowance: null,
      committed: 12,
      remaining: null,
      usageQuantity: 12,
    });

    const result = await loader({
      request: new Request("https://example.test/app/billing"),
    } as never);

    expect(result.subscription).toMatchObject({
      status: "ACTIVE",
      planKind: "PAID_METERED",
      planName: "Growth",
      pendingPlanName: "Free",
      pendingEffectiveAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("reads paid included capacity from the current period counter", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: {
        status: "ACTIVE",
        plan: { kind: "PAID_METERED", name: "Growth" },
        observedShopifyPlanHandle: "growth",
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        pendingPlan: null,
        pendingEffectiveAt: null,
      },
      allowance: null,
      remaining: null,
      paidIncluded: {
        grantedQuantity: 100,
        committedQuantity: 12,
        reservedQuantity: 8,
        forfeitedQuantity: 5,
        remaining: 75,
      },
      paidConfigurationUnavailable: false,
      lifetimeFree: {
        grantedQuantity: 50,
        committedQuantity: 10,
        reservedQuantity: 5,
        remaining: 35,
      },
      usageQuantity: 12,
      purchasedRecoveryCredits: {
        grantedQuantity: 100,
        committedQuantity: 20,
        reservedQuantity: 5,
        refundingQuantity: 10,
        available: 65,
      },
    });

    const result = await loader({
      request: new Request("https://example.test/app/billing"),
    } as never);

    expect(result).toMatchObject({
      allowance: null,
      remaining: null,
      paidIncluded: { remaining: 75 },
      subscription: {
        currentPeriodStart: "2026-09-01T00:00:00.000Z",
        currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      },
    });
    expect(billingRouteSource).toContain('i18n.t("billing.paidIncludedAllowance"');
    expect(billingRouteSource).toContain('i18n.t("billing.lifetimeFreeAllowance"');
    expect(billingRouteSource).toContain('subscription.planKind === "PAID_METERED" &&');
    expect(billingRouteSource).toContain('billingPeriodPhase !== "RECONCILING"');
  });

  it("fails closed when a paid period or period counter is unavailable", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: {
        status: "ACTIVE",
        plan: { kind: "PAID_METERED", name: "Growth" },
        observedShopifyPlanHandle: "growth",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        pendingPlan: null,
        pendingEffectiveAt: null,
      },
      allowance: null,
      remaining: null,
      paidIncluded: null,
      paidConfigurationUnavailable: true,
      lifetimeFree: {
        grantedQuantity: 50,
        committedQuantity: 10,
        reservedQuantity: 5,
        remaining: 35,
      },
      usageQuantity: 999,
    });

    const result = await loader({
      request: new Request("https://example.test/app/billing"),
    } as never);

    expect(result.paidConfigurationUnavailable).toBe(true);
    expect(billingRouteSource).toContain("!paidConfigurationUnavailable");
    expect(billingRouteSource).toContain("billing.configurationUnavailable");
  });

  it("fails closed for an unmapped projection instead of presenting paid entitlement", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: {
        status: "UNMAPPED",
        plan: null,
        observedShopifyPlanHandle: "unknown-plan",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        pendingPlan: null,
        pendingEffectiveAt: null,
      },
      allowance: null,
      committed: 0,
      remaining: null,
      usageQuantity: 0,
    });

    const result = await loader({
      request: new Request("https://example.test/app/billing"),
    } as never);

    expect(result.subscription).toMatchObject({
      status: "UNMAPPED",
      planKind: null,
      planName: "unknown-plan",
    });
    expect(billingRouteSource).toContain("!isSafeProjection");
    expect(billingRouteSource).toContain("billing.configurationUnavailable");
  });

  it("presents purchased balance independently from pack purchase eligibility", () => {
    const purchasedBalanceMarker = 'i18n.t("billing.purchasedRecoveryCredits"';

    const eligibilityMarker = "recoveryCreditPackPurchaseEligible &&";

    expect(billingRouteSource).toContain(purchasedBalanceMarker);

    expect(billingRouteSource).toMatch(
      /recoveryCreditPackPurchaseEligible\s*&&\s*recoveryCreditPackEnabled/,
    );

    const purchasedBalanceIndex = billingRouteSource.indexOf(
      purchasedBalanceMarker,
    );

    const eligibilityIndex = billingRouteSource.indexOf(eligibilityMarker);

    expect(purchasedBalanceIndex).toBeGreaterThanOrEqual(0);
    expect(eligibilityIndex).toBeGreaterThanOrEqual(0);

    expect(purchasedBalanceIndex).toBeLessThan(eligibilityIndex);
  });

  it("returns ineligible state while preserving the purchased balance", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: {
        ...activeFreeSubscription,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      },
      allowance: 10,
      remaining: 10,
      usageQuantity: 0,
      purchasedRecoveryCredits: {
        grantedQuantity: 100,
        committedQuantity: 20,
        reservedQuantity: 0,
        refundingQuantity: 10,
        available: 70,
      },
      recoveryCreditPackEnabled: true,
      recoveryCreditsPerPack: 100,
      recoveryCreditPackMeter: "credit-pack-meter",
      recoveryCreditPackMeterVerified: true,
      recoveryCreditPackPurchaseEligible: false,
    });

    const result = await loader({
      request: new Request("https://example.test/app/billing"),
    } as never);

    expect(result).toMatchObject({
      purchasedRecoveryCredits: { available: 70, refundingQuantity: 10 },
      recoveryCreditPackPurchaseEligible: false,
    });
    expect(billingRouteSource).toContain(
      "recoveryCreditPackPurchaseEligible &&",
    );
    expect(billingRouteSource).toContain('billingPeriodPhase === "ACTIVE" &&');
  });

  it("uses explicit phase copy for each plan and preserves Free lifetime presentation", () => {
    expect(billingRouteSource).toContain('"billing.paidCycleDraining"');
    expect(billingRouteSource).toContain('"billing.paidCycleReconciling"');
    expect(billingRouteSource).toContain('"billing.freeCycleDraining"');
    expect(billingRouteSource).toContain('"billing.freeCycleReconciling"');
    expect(billingRouteSource).toContain('i18n.t("billing.lifetimeFreeAllowance"');
    expect(billingRouteSource).toContain('billingPeriodPhase !== "RECONCILING"');
    expect(billingRouteSource).not.toContain('i18n.t("billing.configurationUnavailableDescription")</p>');
    expect(billingRouteSource).not.toContain('i18n.t("billing.recoveryCreditPurchasePending")</p>');
  });

  it("uses durable RECONCILING phase to hide expired Paid included capacity", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: {
        status: "ACTIVE",
        plan: { kind: "PAID_METERED", name: "Growth" },
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      },
      billingPeriodPhase: "RECONCILING",
      paidIncluded: {
        grantedQuantity: 100,
        committedQuantity: 20,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
        remaining: 80,
      },
      recoveryCreditPackPurchaseEligible: false,
      lifetimeFree: {
        grantedQuantity: 50,
        committedQuantity: 10,
        reservedQuantity: 5,
        remaining: 35,
      },
      purchasedRecoveryCredits: {
        grantedQuantity: 0,
        committedQuantity: 0,
        reservedQuantity: 0,
        refundingQuantity: 0,
        available: 0,
      },
    });

    const result = await loader({
      request: new Request("https://example.test/app/billing"),
    } as never);

    expect(result).toMatchObject({
      billingPeriodPhase: "RECONCILING",
      paidIncluded: { remaining: 80 },
      recoveryCreditPackPurchaseEligible: false,
    });
    expect(billingRouteSource).toContain('billingPeriodPhase !== "RECONCILING"');
    expect(billingRouteSource).toContain('"billing.paidCycleReconciling"');
  });

  it("maps known billing codes once and leaves unknown codes non-actionable", () => {
    expect(
      getMerchantSystemMessageAction("BILLING_FREE_ALLOWANCE_WARNING"),
    ).toEqual({
      href: "/app/billing/select",
      labelKey: "billing.viewPlans",
    });
    expect(
      getMerchantSystemMessageAction("BILLING_SAFETY_LIMIT_REACHED"),
    ).toEqual({
      href: "/app/billing",
      labelKey: "billing.viewPlans",
    });
    expect(getMerchantSystemMessageAction("UNKNOWN_BILLING_CODE")).toBeNull();
  });
});
