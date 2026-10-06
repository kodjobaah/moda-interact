import { createElement, type ReactNode } from "react";
import { access, readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLoaderData } from "react-router";

const readSource = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const routesSource = await readSource("../../app/routes.ts");
const optionsSource = await readSource("../../app/routes/app/billing/options/route.tsx");
const selectSource = await readSource("../../app/routes/app/billing/select/route.jsx");
const callbackSource = await readSource("../../app/routes/app/billing/callback/route.tsx");
const onboardingSource = await readSource("../../app/components/onboarding/Onboarding.jsx");
const breadcrumbsSource = await readSource("../../app/components/dashboard/Breadcrumbs.jsx");
const systemActionsSource = await readSource("../../app/services/merchant-support/system-message-actions.ts");
const { getMerchantSystemMessageAction } = await import("../../app/services/merchant-support/system-message-actions");

describe("canonical merchant billing UI", () => {
  it("nests billing options and keeps transition routes standalone", () => {
    expect(routesSource).toContain('route("billing/options", "./routes/app/billing/options/route.tsx"),');
    expect(routesSource).toContain('route("billing/recovery-credit-purchases", "./routes/app/billing/recovery-credit-purchases/route.tsx"),');
    expect(routesSource).not.toContain('route("billing", "./routes/app/billing/route.tsx")');
    expect(routesSource).not.toContain('route("app/billing/options", "./routes/app/billing/options/route.tsx")');
    expect(routesSource).toContain('route("app/billing/select", "./routes/app/billing/select/route.jsx"),');
    expect(routesSource).toContain('route("app/billing/callback", "./routes/app/billing/callback/route.tsx"),');
  });

  it("uses the canonical billing heading and preserves callback returns", () => {
    expect(optionsSource).toContain('heading={i18n.t("billingCommerce.page.title")}');
    expect(optionsSource).toContain('<s-button href={data.usageHistoryHref} variant="secondary">');
    expect(optionsSource).not.toContain('<s-link href={data.usageHistoryHref}>');
    expect(callbackSource).toContain("/app/billing/options");
    expect(selectSource).toContain('target: "_top"');
  });

  it("sends onboarding plan CTA to Shopify plan selection after category persistence", () => {
    expect(onboardingSource).not.toContain('href="/app/billing"');
    expect(onboardingSource).not.toContain('href="/app/billing/select"');
    expect(onboardingSource).toContain('navigate("/app/billing/select")');
    expect(onboardingSource).toContain('action: "/app/store-profile/category"');
  });

  it("maps billing system messages to lifecycle-allowed destinations", () => {
    expect(getMerchantSystemMessageAction("BILLING_FREE_ALLOWANCE_WARNING", "NO_CONTRACT")).toEqual({ href: "/app/billing/select", labelKey: "billing.viewPlans" });
    expect(getMerchantSystemMessageAction("BILLING_FREE_ALLOWANCE_WARNING", "FROZEN")).toBeNull();
    expect(getMerchantSystemMessageAction("BILLING_SAFETY_LIMIT_REACHED", "NO_CONTRACT")).toEqual({ href: "/app/billing/options", labelKey: "billing.viewPlans" });
    expect(getMerchantSystemMessageAction("BILLING_SAFETY_LIMIT_REACHED", "SUPPORT_ONLY")).toBeNull();
    expect(getMerchantSystemMessageAction("BILLING_SUBSCRIPTION_ENDED", "POST_CONTRACT")).toEqual({
      href: "/app/billing/options",
      labelKey: "billing.subscribeAgain",
    });
    expect(systemActionsSource).not.toContain('"/app/billing"');
  });

  it("keeps the breadcrumb API declarative", () => {
    expect(breadcrumbsSource).toContain("items = []");
    expect(breadcrumbsSource).not.toContain('to="/app"');
    expect(breadcrumbsSource).not.toContain("usage.title");
  });

  it("does not retain retired billing modules", async () => {
    for (const path of [
      "../../app/routes/app/billing/route.tsx",
      "../../app/routes/app/additional/route.jsx",
      "../../app/routes/app/billing/recovery-credits/route.ts",
    ]) {
      await expect(access(new URL(path, import.meta.url))).rejects.toThrow();
    }
  });
});
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>(
    "react-router",
  );
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: ReactNode }) =>
      createElement("a", { href: to }, children),
    useFetcher: vi.fn(() => ({ data: null, state: "idle" })),
    useNavigation: vi.fn(() => ({ state: "idle" })),
    useSubmit: vi.fn(() => vi.fn()),
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
const getSubscription = vi.fn();
const requestRecoveryCreditPack = vi.fn();
const findShopSettings = vi.fn();
const hostedPricingRedirect = vi.fn();
const billingOptionsRouteSource = await readFile(
  new URL("../../app/routes/app/billing/options/route.tsx", import.meta.url),
  "utf8",
);
const purchaseHistoryRouteSource = await readFile(
  new URL(
    "../../app/routes/app/billing/recovery-credit-purchases/route.tsx",
    import.meta.url,
  ),
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
    getSubscription,
    requestRecoveryCreditPack,
  },
}));
vi.mock("../../app/db.server", () => ({
  default: { shopSettings: { findUnique: findShopSettings } },
}));

const { default: BillingRoute } =
  await import("../../app/routes/app/billing/options/route");
const { loader: billingOptionsLoader } =
  await import("../../app/routes/app/billing/options/route");
const { action: billingOptionsAction } =
  await import("../../app/routes/app/billing/options/route");
const billingAction = billingOptionsAction;
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
    lifecycleState: "ACTIVE",
    purchaseHistoryAvailable: true,
    verificationState: "ACTIVE_SUBSCRIPTION",
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
  resolveShopifyShop.mockResolvedValue({
    id: "shop-1",
    status: "ACTIVE",
    onboardingCompleted: true,
  });
  findShopSettings.mockResolvedValue(null);
  getSubscription.mockResolvedValue({ status: "ACTIVE" });
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
    expect(billingOptionsRouteSource).not.toContain(
      "getMerchantShopifyLifecycleState(shop.id)",
    );
    expect(billingOptionsRouteSource).toContain(
      "getMerchantShopifySubscriptionState(shop.id)",
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


  it("reuses one verified active-subscription snapshot for commercial presentation and top-up offers", async () => {
    const commercial = {
      status: "ACTIVE_SUBSCRIPTION",
      subscription: {
        planHandle: "free",
        description: "Free",
        price: { amount: "0.00", currency: "USD" },
        billingPeriod: "EVERY_30_DAYS",
        currentPeriodStart: "2026-09-19T11:32:08.000Z",
        currentPeriodEnd: "2026-10-19T11:32:08.000Z",
        trialEndsAt: null,
        cancelAtEndOfCycle: false,
        pendingUpdate: null,
        usageItems: [],
      },
      modaMapping: { id: "free-1", name: "Free", kind: "FREE" },
      mappingStatus: "MAPPED",
      pendingModaMapping: null,
    };
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscriptionProjection.mockResolvedValue({
      status: "ACTIVE",
      observedShopifyPlanHandle: "free",
      plan: { id: "free-1", shopifyPlanHandle: "free", name: "Free", kind: "FREE", active: true },
    });
    getMerchantShopifySubscriptionState.mockResolvedValue(commercial);
    getMerchantRecoveryCapacityState.mockResolvedValue({ availability: "AVAILABLE" });
    getMerchantBillingState.mockResolvedValue({
      billingPeriodPhase: "ACTIVE",
      recoveryCreditOffers: [],
      recoveryCreditOfferVerificationState: "VERIFIED",
      purchasedRecoveryCredits: { available: 0 },
      latestPurchase: null,
      purchaseEligible: false,
    });

    const data = await billingOptionsLoader({
      request: new Request("https://example.test/app/billing/options?plan_change=unverified&requested_plan_handle=free"),
    } as never);

    expect(data.verificationState).toBe("ACTIVE_SUBSCRIPTION");
    expect(data.requestedSelection).toBeNull();
    expect(getMerchantBillingState).toHaveBeenCalledWith("shop-1", commercial);
    expect(getMerchantShopifySubscriptionState).toHaveBeenCalledTimes(1);
    expect(getMerchantShopifyLifecycleState).not.toHaveBeenCalled();
  });

  it("returns the durable mapped contract when live Shopify verification is unavailable", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscriptionProjection.mockResolvedValue({
      status: "ACTIVE",
      observedShopifyPlanHandle: "free",
      currentPeriodStart: new Date("2026-09-19T12:32:08.000Z"),
      currentPeriodEnd: new Date("2026-10-19T12:32:08.000Z"),
      cancelAtPeriodEnd: false,
      plan: { id: "free-1", shopifyPlanHandle: "free", name: "Free", kind: "FREE", active: true },
    });
    getMerchantShopifySubscriptionState.mockRejectedValue(new Error("Partner API unavailable"));
    getMerchantRecoveryCapacityState.mockResolvedValue({ availability: "AVAILABLE" });

    const data = await billingOptionsLoader({
      request: new Request("https://example.test/app/billing/options"),
    } as never);

    expect(data.verificationState).toBe("VERIFICATION_UNAVAILABLE");
    expect(data.currentContract).toEqual({
      shopifyPlanHandle: "free",
      mappedModaPlanName: "Free",
      mappedModaPlanKind: "FREE",
      currentPeriodStart: "2026-09-19T12:32:08.000Z",
      currentPeriodEnd: "2026-10-19T12:32:08.000Z",
      cancelAtEndOfCycle: false,
      price: null,
      interval: null,
    });
    expect(data.commercial).toBeNull();
    expect(getMerchantBillingState).not.toHaveBeenCalled();
  });

  it("allows an eligible top-up while scheduled cancellation keeps the current provider contract active", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "AVAILABLE",
      canStartRecovery: true,
    });
    getSubscriptionProjection.mockResolvedValue({ status: "ACTIVE" });
    getMerchantShopifySubscriptionState.mockResolvedValue({
      status: "ACTIVE_SUBSCRIPTION",
      subscription: {
        cancelAtEndOfCycle: true,
        pendingUpdate: null,
      },
    });
    requestRecoveryCreditPack.mockResolvedValue({
      status: "REQUESTED",
      currentAmount: 0,
      usageEvent: { shopifyReportState: "PENDING" },
    });

    const body = new URLSearchParams({
      intent: "BUY_RECOVERY_CREDIT_PACK",
      purchaseId: "purchase-1",
      eventHandle: "bronze-top-up-free",
    });
    const result = await billingAction({
      request: new Request("https://example.test/app/billing/options", { method: "POST", body }),
    } as never);

    expect(requestRecoveryCreditPack).toHaveBeenCalledWith(
      "shop-1",
      "BUY_RECOVERY_CREDIT_PACK",
      "purchase-1",
      "bronze-top-up-free",
    );
    expect(result).toEqual({
      purchase: {
        status: "REQUESTED",
        currentAmount: 0,
        usageReportState: "PENDING",
      },
    });
  });

  it("denies a post-contract top-up even if provider verification momentarily reports an active subscription", async () => {
    getSubscriptionProjection.mockResolvedValue({
      status: "NO_CONTRACT",
      lastProviderLifecycleState: "CANCELED",
    });
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "POST_CONTRACT_AVAILABLE",
      canStartRecovery: true,
    });
    getMerchantShopifySubscriptionState.mockResolvedValue({
      status: "ACTIVE_SUBSCRIPTION",
      subscription: { cancelAtEndOfCycle: false, pendingUpdate: null },
    });

    const body = new URLSearchParams({
      intent: "BUY_RECOVERY_CREDIT_PACK",
      purchaseId: "purchase-post-contract",
      eventHandle: "bronze-top-up-free",
    });

    await expect(
      billingAction({
        request: new Request("https://example.test/app/billing/options", { method: "POST", body }),
      } as never),
    ).rejects.toThrow("Recovery credit packs are unavailable while Shopify billing is restricted.");
    expect(requestRecoveryCreditPack).not.toHaveBeenCalled();
  });

  it("keeps the scheduled-cancellation top-up CTA enabled when normal eligibility passes", () => {
    useLoaderDataMock.mockReturnValue({
      merchantUi: { locale: "en-GB", fallbackLocale: "en", timeZone: "UTC" },
      commercial: {
        status: "ACTIVE_SUBSCRIPTION",
        subscription: {
          planHandle: "free",
          price: null,
          billingPeriod: "EVERY_30_DAYS",
          currentPeriodEnd: "2026-10-19T00:00:00.000Z",
          cancelAtEndOfCycle: true,
          pendingUpdate: null,
        },
        modaMapping: { id: "free-1", name: "Free", kind: "FREE" },
        mappingStatus: "MAPPED",
      },
      currentContract: null,
      capacity: {
        availability: "AVAILABLE",
        freeLifetime: { granted: 5, remaining: 5 },
        promotional: { remaining: 0 },
        purchased: { available: 0 },
      },
      topUp: {
        billingPeriodPhase: "ACTIVE",
        recoveryCreditOffers: [{
          eventHandle: "bronze-top-up-free",
          label: "Bronze",
          cataloguePosition: 0,
          creditsGranted: 1,
          providerPrice: { currency: "USD", tiers: [{ amountPerUnit: "0.00" }] },
          providerUsage: null,
        }],
        recoveryCreditOfferVerificationState: "VERIFIED",
        purchasedRecoveryCredits: { available: 0 },
        latestPurchase: null,
        unresolvedPurchases: [],
        purchaseEligible: true,
      },
      billingPeriodPhase: "ACTIVE",
      lifecycleState: "ACTIVE",
      verificationState: "ACTIVE_SUBSCRIPTION",
      scheduledCancellation: true,
      requestedSelection: null,
      usageHistoryAvailable: false,
      usageHistoryHref: "/app/usage",
      purchaseHistoryAvailable: false,
    } as never);

    const markup = renderToStaticMarkup(createElement(BillingRoute));
    const buyButton = markup.match(/<button[^>]*aria-label="Buy 1 recovery conversations"[^>]*>/)?.[0] ?? "";

    expect(markup).toContain("subscription is scheduled to end");
    expect(markup).toContain("top-ups normally available to it until then");
    expect(buyButton).not.toContain("disabled");
  });

  it("loads verified ended subscriptions as post-contract without reading top-up offers", async () => {
    getSubscriptionProjection.mockResolvedValue({
      status: "NO_CONTRACT",
      lastProviderLifecycleState: "CANCELED",
      plan: null,
      observedShopifyPlanHandle: null,
    });
    getMerchantShopifySubscriptionState.mockResolvedValue({
      status: "NO_ACTIVE_SUBSCRIPTION",
      subscription: null,
    });
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "POST_CONTRACT_AVAILABLE",
      capacitySource: "PURCHASED",
      canStartRecovery: true,
      freeLifetime: { granted: 5, committed: 1, reserved: 0, remaining: 4 },
      promotional: { granted: 0, committed: 0, reserved: 0, remaining: 0 },
      purchased: {
        granted: 10,
        committed: 2,
        reserved: 1,
        refunding: 0,
        available: 7,
      },
    });

    const data = await billingOptionsLoader({
      request: new Request("https://example.test/app/billing/options"),
    } as never);

    expect(data.lifecycleState).toBe("POST_CONTRACT");
    expect(data.capacity).toMatchObject({
      availability: "POST_CONTRACT_AVAILABLE",
      capacitySource: "PURCHASED",
    });
    expect(data.verificationState).toBe("NO_ACTIVE_SUBSCRIPTION");
    expect(getMerchantBillingState).not.toHaveBeenCalled();
  });

  it("presents remaining durable credits with Subscribe again and no top-up action after contract end", () => {
    useLoaderDataMock.mockReturnValue({
      merchantUi: { locale: "en-GB", fallbackLocale: "en", timeZone: "UTC" },
      commercial: { status: "NO_ACTIVE_SUBSCRIPTION", subscription: null },
      currentContract: null,
      capacity: {
        availability: "POST_CONTRACT_AVAILABLE",
        capacitySource: "PURCHASED",
        canStartRecovery: true,
        paidIncluded: null,
        freeLifetime: { granted: 5, committed: 1, reserved: 0, remaining: 4 },
        promotional: { granted: 0, committed: 0, reserved: 0, remaining: 0 },
        purchased: {
          granted: 10,
          committed: 2,
          reserved: 1,
          refunding: 0,
          available: 7,
        },
      },
      topUp: null,
      billingPeriodPhase: null,
      lifecycleState: "POST_CONTRACT",
      verificationState: "NO_ACTIVE_SUBSCRIPTION",
      scheduledCancellation: false,
      requestedSelection: null,
      usageHistoryAvailable: false,
      usageHistoryHref: "/app/usage",
      purchaseHistoryAvailable: true,
    } as never);

    const markup = renderToStaticMarkup(createElement(BillingRoute));

    expect(markup).toContain("No active subscription");
    expect(markup).toContain("remaining purchased and lifetime Free recovery credits");
    expect(markup).toContain("Subscribe again");
    expect(markup).toContain(">4<");
    expect(markup).toContain(">7<");
    expect(markup).not.toContain("Add top-up");
    expect(markup).not.toContain("BUY_RECOVERY_CREDIT_PACK");
  });

  it("hides top-up and plan management while capacity is frozen", () => {
    const markup = renderBillingRoute({
      lifecycleState: "FROZEN",
    });

    expect(markup).not.toContain("<form");
    expect(markup).not.toContain('href="/app/billing/select"');
  });

  it("maps known billing codes once and leaves unknown codes non-actionable", () => {
    expect(
      getMerchantSystemMessageAction("BILLING_FREE_ALLOWANCE_WARNING", "ACTIVE"),
    ).toEqual({
      href: "/app/billing/select",
      labelKey: "billing.viewPlans",
    });
    expect(
      getMerchantSystemMessageAction("BILLING_SAFETY_LIMIT_REACHED", "ACTIVE"),
    ).toEqual({
      href: "/app/billing/options",
      labelKey: "billing.viewPlans",
    });
    expect(getMerchantSystemMessageAction("UNKNOWN_BILLING_CODE", "ACTIVE")).toBeNull();
  });

  it("keeps purchase-history authorization on the canonical surface", () => {
    expect(purchaseHistoryRouteSource).toContain('"BILLING_PURCHASE_HISTORY"');
  });

  it.each([
    ["ONBOARDING", false, false, "NO_CONTRACT"],
    ["ACTIVE", true, true, "ACTIVE"],
    ["NO_CONTRACT", true, true, "NO_CONTRACT"],
    ["FROZEN", true, true, "FROZEN"],
    ["BILLING_ATTENTION", true, true, "UNMAPPED"],
  ] as const)("derives purchase-history presentation for %s", async (_state, expected, onboardingCompleted, subscriptionStatus) => {
    resolveShopifyShop.mockResolvedValue({
      id: "shop-1",
      status: "ACTIVE",
      onboardingCompleted,
    });
    getSubscriptionProjection.mockResolvedValue({ status: subscriptionStatus });
    if (_state === "ONBOARDING") {
      await expect(
        billingOptionsLoader({
          request: new Request("https://example.test/app/billing/options"),
        } as never),
      ).rejects.toMatchObject({ status: 302 });
      return;
    }
    const data = await billingOptionsLoader({
      request: new Request("https://example.test/app/billing/options"),
    } as never);
    expect(data.purchaseHistoryAvailable).toBe(expected);
  });
});
