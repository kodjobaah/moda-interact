import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const getSubscription = vi.fn();
const getSubscriptionProjection = vi.fn();
const getMerchantRecoveryCapacityState = vi.fn();
const findShopSettings = vi.fn();
const readPendingRecoveries = vi.fn();
const findRecoveries = vi.fn();
const findBillingPeriods = vi.fn();
const findBillingPeriod = vi.fn();
const readRecoveryOverview = vi.fn();
const findUsageEvents = vi.fn();
const readActiveMerchantPricingCatalogue = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../app/services/billing/billing.service", () => ({
  billingService: {
    getSubscription,
    getSubscriptionProjection,
    getMerchantRecoveryCapacityState,
  },
}));
vi.mock(
  "../../app/services/pending-recovery/pending-recovery-reader.server",
  () => ({
    readPendingRecoveries,
  }),
);
vi.mock("../../app/services/merchant-pricing/merchant-pricing.server", () => ({
  readActiveMerchantPricingCatalogue,
}));
vi.mock("../../app/services/recoveries/recovery-readers.server", () => ({
  readRecoveryOverview,
}));
vi.mock("../../app/db.server", () => ({
  default: {
    shopSettings: { findUnique: findShopSettings },
    checkoutRecovery: { findMany: findRecoveries },
    billingPeriod: {
      findMany: findBillingPeriods,
      findFirst: findBillingPeriod,
    },
    usageEvent: { findMany: findUsageEvents },
  },
}));

const { loader } = await import("../../app/routes/app/home/route");

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    admin: { id: "shopify-admin" },
    session: { shop: "merchant.myshopify.com", locale: "en-GB" },
  });
  resolveShopifyShop.mockResolvedValue({
    id: "shop-1",
    domain: "merchant.myshopify.com",
    status: "ACTIVE",
  });
  findShopSettings.mockResolvedValue({ onboardingCompleted: false });
  getMerchantRecoveryCapacityState.mockResolvedValue({
    availability: "CONTRACT_REQUIRED",
    observedShopifyPlanHandle: null,
  });
  getSubscriptionProjection.mockResolvedValue(null);
  readPendingRecoveries.mockResolvedValue({ available: true, items: [] });
  readActiveMerchantPricingCatalogue.mockResolvedValue([]);
  readRecoveryOverview.mockResolvedValue({
    summary: { started: 0 },
    preview: [],
  });
  findBillingPeriod.mockResolvedValue(null);
  findRecoveries.mockResolvedValue([]);
  findBillingPeriods.mockResolvedValue([]);
  findUsageEvents.mockResolvedValue([]);
});

describe("app home loader", () => {
  it("returns onboarding data without loading dashboard datasets", async () => {
    readActiveMerchantPricingCatalogue.mockResolvedValue([
      { shopifyPlanHandle: "free" },
    ]);
    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      settings: { onboardingCompleted: false },
      merchantExperienceState: "ONBOARDING",
      pricingCatalogue: [{ shopifyPlanHandle: "free" }],
      subscription: null,
    });
    expect(getSubscription).not.toHaveBeenCalled();
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("keeps detail requests on the onboarding surface", async () => {
    const result = await loader({
      request: new Request(
        "https://example.test/app?view=detail&billId=missing-period",
      ),
    });

    expect(result).toMatchObject({
      merchantExperienceState: "ONBOARDING",
      subscription: null,
    });
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("shows subscription setup instead of plan selection once durable Shopify evidence exists", async () => {
    readActiveMerchantPricingCatalogue.mockResolvedValue([
      {
        shopifyPlanHandle: "free",
        displayName: "Free",
      },
    ]);
    getSubscriptionProjection.mockResolvedValue({
      status: "UNMAPPED",
      observedShopifyPlanHandle: "free",
      pendingShopifyPlanHandle: null,
      providerSubscriptionId: "gid://shopify/AppSubscription/1",
      currentPeriodStart: new Date("2026-09-18T21:20:00.000Z"),
      currentPeriodEnd: new Date("2026-10-18T21:20:00.000Z"),
      lastSyncedAt: new Date("2026-09-18T21:45:40.710Z"),
    });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      settings: { onboardingCompleted: false },
      merchantExperienceState: "ONBOARDING",
      billingSetup: {
        phase: "FINALIZING_SUBSCRIPTION",
        planHandle: "free",
        planName: "Free",
        currentPeriodStart: "2026-09-18T21:20:00.000Z",
        currentPeriodEnd: "2026-10-18T21:20:00.000Z",
      },
      subscription: null,
    });
    expect(getMerchantRecoveryCapacityState).not.toHaveBeenCalled();
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("keeps a completed shop without an active plan on the merchant surface", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscriptionProjection.mockResolvedValue({
      status: "NO_CONTRACT",
      plan: null,
      observedShopifyPlanHandle: null,
      pendingShopifyPlanHandle: null,
    });
    readActiveMerchantPricingCatalogue.mockResolvedValue([
      { shopifyPlanHandle: "database-plan" },
    ]);

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      settings: { onboardingCompleted: true },
      merchantExperienceState: "NO_CONTRACT",
      subscription: { status: "NO_CONTRACT" },
      pricingCatalogue: [{ shopifyPlanHandle: "database-plan" }],
      capacity: { availability: "CONTRACT_REQUIRED" },
    });
    expect(readRecoveryOverview).toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("preserves pending plan and scheduled cancellation precedence in dashboard data", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscription.mockResolvedValue({
      status: "ACTIVE",
      observedShopifyPlanHandle: "growth",
    });
    getSubscriptionProjection.mockResolvedValue({
      status: "ACTIVE",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
      pendingEffectiveAt: new Date("2026-09-20T00:00:00.000Z"),
      pendingPlan: { name: "Basic" },
    });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result.subscription).toMatchObject({
      status: "ACTIVE",
      cancelAtEndOfCycle: true,
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      pendingPlan: {
        name: "Basic",
        effectiveAt: "2026-09-20T00:00:00.000Z",
      },
    });
  });

  it("keeps historical dashboard data readable without reading pending recoveries for denied states", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscriptionProjection.mockResolvedValue({ status: "NO_CONTRACT" });
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "CONTRACT_FROZEN",
      canStartRecovery: false,
    });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      subscription: { status: "NO_CONTRACT" },
      capacity: { availability: "CONTRACT_FROZEN", canStartRecovery: false },
      pendingRecoveries: {
        available: false,
        page: 1,
        pageSize: 10,
        total: 0,
        totalPages: 0,
        items: [],
      },
    });
    expect(readPendingRecoveries).not.toHaveBeenCalled();
  });

  it("keeps billing-attention history readable while exposing setup state", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    readActiveMerchantPricingCatalogue.mockResolvedValue([
      {
        shopifyPlanHandle: "free",
        displayName: "Free",
      },
    ]);
    getSubscriptionProjection.mockResolvedValue({
      status: "UNMAPPED",
      observedShopifyPlanHandle: "free",
      providerSubscriptionId: "gid://shopify/AppSubscription/1",
      currentPeriodStart: new Date("2026-09-18T21:20:00.000Z"),
      currentPeriodEnd: new Date("2026-10-18T21:20:00.000Z"),
      lastSyncedAt: new Date("2026-09-18T21:45:40.710Z"),
    });
    getMerchantRecoveryCapacityState.mockResolvedValue({
      availability: "CONFIGURATION_UNAVAILABLE",
      observedShopifyPlanHandle: "free",
    });

    const result = await loader({
      request: new Request("https://example.test/app"),
    });

    expect(result).toMatchObject({
      merchantExperienceState: "BILLING_ATTENTION",
      billingSetup: {
        phase: "FINALIZING_SUBSCRIPTION",
        planName: "Free",
      },
      capacity: { availability: "CONFIGURATION_UNAVAILABLE" },
      pendingRecoveries: { available: false, items: [] },
    });
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(readRecoveryOverview).toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });

  it("redirects pending reinstall before reading product data", async () => {
    resolveShopifyShop.mockResolvedValue({
      id: "shop-1",
      domain: "merchant.myshopify.com",
      status: "UNINSTALLED",
      reinstallPendingAt: new Date("2026-09-14T00:00:00.000Z"),
    });

    await expect(
      loader({
        request: new Request("https://example.test/app"),
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(Response);
      expect(error.headers.get("Location")).toBe("/app/reinstalling");
      return true;
    });

    expect(findShopSettings).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();
    expect(readPendingRecoveries).not.toHaveBeenCalled();
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });
  it("uses the normalized date cohort without hydrating billing or conversations", async () => {
    findShopSettings.mockResolvedValue({
      onboardingCompleted: true,
      timeZone: "America/New_York",
    });
    getSubscriptionProjection.mockResolvedValue({ status: "ACTIVE" });
    await loader({
      request: new Request(
        "https://example.test/app?from=2026-09-01&to=2026-09-10&status=FAILED&q=ignored&pageSize=50",
      ),
    });
    expect(readRecoveryOverview).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        from: "2026-09-01",
        to: "2026-09-10",
        status: "all",
        q: "",
        cursor: null,
      }),
    );
    expect(findRecoveries).not.toHaveBeenCalled();
    expect(findBillingPeriods).not.toHaveBeenCalled();
    expect(findUsageEvents).not.toHaveBeenCalled();
  });
  it.each(["ACTIVE", "NO_CONTRACT", "FROZEN", "UNMAPPED"])(
    "redirects authorized legacy entry before performance/capacity reads for %s",
    async (status) => {
      findShopSettings.mockResolvedValue({ onboardingCompleted: true });
      getSubscriptionProjection.mockResolvedValue({ status });
      findBillingPeriod.mockResolvedValue({ id: "owned-period" });
      await expect(
        loader({
          request: new Request(
            "https://example.test/app?view=detail&bill=past&billId=owned-period&from=bad&shop=attacker&host=aG9zdA==&embedded=1",
          ),
        }),
      ).rejects.toSatisfy((response: Response) => {
        expect(response.status).toBe(302);
        const url = new URL(
          response.headers.get("Location")!,
          "https://example.test",
        );
        expect(url.pathname).toBe("/app/usage");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          shop: "merchant.myshopify.com",
          host: "aG9zdA==",
          embedded: "1",
          bill: "past",
          billId: "owned-period",
        });
        return true;
      });
      expect(findBillingPeriod).toHaveBeenCalledWith({
        where: { id: "owned-period", shopId: "shop-1" },
        select: { id: true },
      });
      expect(readRecoveryOverview).not.toHaveBeenCalled();
      expect(getMerchantRecoveryCapacityState).not.toHaveBeenCalled();
      expect(readPendingRecoveries).not.toHaveBeenCalled();
    },
  );
  it.each([
    "missing-period",
    "deleted-period",
    "other-tenant",
    "https://evil.test",
    "x".repeat(129),
    "",
  ])(
    "shows an explicit unavailable state for requested bill ID %s without substituting a default",
    async (billId) => {
      findShopSettings.mockResolvedValue({ onboardingCompleted: true });
      getSubscriptionProjection.mockResolvedValue({ status: "ACTIVE" });
      const result = await loader({
        request: new Request(
          `https://example.test/app?view=detail&bill=past&billId=${encodeURIComponent(billId)}&shop=attacker&host=aG9zdA==&embedded=1`,
        ),
      });
      expect(result).toMatchObject({
        legacyBillingUnavailable: true,
        embed: {
          shop: "merchant.myshopify.com",
          host: "aG9zdA==",
          embedded: "1",
        },
      });
      expect(result).not.toHaveProperty("performance");
      expect(result).not.toHaveProperty("billId");
      expect(readRecoveryOverview).not.toHaveBeenCalled();
      expect(getMerchantRecoveryCapacityState).not.toHaveBeenCalled();
      expect(readPendingRecoveries).not.toHaveBeenCalled();
      expect(findBillingPeriods).not.toHaveBeenCalled();
      expect(findUsageEvents).not.toHaveBeenCalled();
      if (/^[A-Za-z0-9_-]{1,128}$/.test(billId))
        expect(findBillingPeriod).toHaveBeenCalledWith({
          where: { id: billId, shopId: "shop-1" },
          select: { id: true },
        });
      else expect(findBillingPeriod).not.toHaveBeenCalled();
    },
  );
  it.each(["current", "past"])(
    "allows a default only when no bill ID was requested (%s)",
    async (bill) => {
      findShopSettings.mockResolvedValue({ onboardingCompleted: true });
      getSubscriptionProjection.mockResolvedValue({ status: "ACTIVE" });
      await expect(
        loader({
          request: new Request(
            `https://example.test/app?view=detail&bill=${bill}`,
          ),
        }),
      ).rejects.toSatisfy((response: Response) => {
        expect(response.headers.get("Location")).toBe(
          `/app/usage?shop=merchant.myshopify.com&bill=${bill}`,
        );
        return true;
      });
      expect(findBillingPeriod).not.toHaveBeenCalled();
      expect(readRecoveryOverview).not.toHaveBeenCalled();
    },
  );
  it("rejects ambiguous repeated period IDs without lookup", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    const result = await loader({
      request: new Request(
        "https://example.test/app?view=detail&billId=owned-period&billId=other-period",
      ),
    });
    expect(result.legacyBillingUnavailable).toBe(true);
    expect(findBillingPeriod).not.toHaveBeenCalled();
  });
  it("keeps history visible when capacity fails", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    getSubscriptionProjection.mockResolvedValue({ status: "ACTIVE" });
    getMerchantRecoveryCapacityState.mockRejectedValue(
      new Error("private capacity failure"),
    );
    const result = await loader({
      request: new Request("https://example.test/app"),
    });
    expect(result.capacity).toBeNull();
    expect(result.performance?.state).toBe("ready");
  });
  it("returns an editable invalid date state without reading recovery data", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    const result = await loader({
      request: new Request("https://example.test/app?from=bad"),
    });
    expect(result.performance?.state).toBe("invalid");
    expect(readRecoveryOverview).not.toHaveBeenCalled();
  });
  it("isolates a recovery read failure without leaking its message", async () => {
    findShopSettings.mockResolvedValue({ onboardingCompleted: true });
    readRecoveryOverview.mockRejectedValue(
      new Error("private database failure"),
    );
    const result = await loader({
      request: new Request("https://example.test/app"),
    });
    expect(result.performance?.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain("private database");
  });
});
