import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const getMerchantBillingState = vi.fn();
const findShopSettings = vi.fn();
const hostedPricingRedirect = vi.fn();
const billingRouteSource = await readFile(
  new URL("../../app/routes/app.billing.tsx", import.meta.url),
  "utf8",
);

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop },
}));
vi.mock("../../app/services/billing/billing.service", () => ({
  billingService: { getMerchantBillingState },
}));
vi.mock("../../app/db.server", () => ({
  default: { shopSettings: { findUnique: findShopSettings } },
}));

const { loader } = await import("../../app/routes/app.billing");
const { loader: billingSelectLoader } = await import("../../app/routes/app.billing.select");
const { getMerchantSystemMessageAction } = await import(
  "../../app/services/merchant-support/system-message-actions"
);

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
  resolveShopifyShop.mockResolvedValue({ id: "shop-1" });
  findShopSettings.mockResolvedValue(null);
});

describe("merchant billing UI", () => {
  it("redirects a no-contract merchant to hosted plan selection", async () => {
    getMerchantBillingState.mockResolvedValue({
      subscription: { status: "NO_CONTRACT" },
      allowance: null,
      committed: 0,
      remaining: null,
      usageQuantity: 0,
    });

    const responsePromise = loader({ request: new Request("https://example.test/app/billing") } as never);

    await expect(responsePromise).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
    await expect(responsePromise.catch((response) => response.headers.get("Location"))).resolves.toBe("/app/billing/select");
  });

  it("redirects the selection route to Shopify pricing with a top-level target", async () => {
    process.env.SHOPIFY_APP_HANDLE = "moda-interact";
    hostedPricingRedirect.mockReturnValue({ type: "redirect" });

    await expect(
      billingSelectLoader({ request: new Request("https://example.test/app/billing/select") } as never),
    ).resolves.toEqual({ type: "redirect" });

    expect(hostedPricingRedirect).toHaveBeenCalledWith(
      "https://admin.shopify.com/store/merchant/charges/moda-interact/pricing_plans",
      { target: "_top" },
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

    const result = await loader({ request: new Request("https://example.test/app/billing") } as never);

    expect(result.subscription).toMatchObject({
      status: "ACTIVE",
      planKind: "FREE",
      planName: "Free",
      pendingPlanName: "Basic",
      pendingEffectiveAt: "2026-10-01T00:00:00.000Z",
    });
    expect(result).toMatchObject({ allowance: 7, remaining: 4, usageQuantity: 3 });
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

    const result = await loader({ request: new Request("https://example.test/app/billing") } as never);

    expect(result.subscription).toMatchObject({
      status: "ACTIVE",
      planKind: "PAID_METERED",
      planName: "Growth",
      pendingPlanName: "Free",
      pendingEffectiveAt: "2026-10-01T00:00:00.000Z",
    });
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

    const result = await loader({ request: new Request("https://example.test/app/billing") } as never);

    expect(result.subscription).toMatchObject({
      status: "UNMAPPED",
      planKind: null,
      planName: "unknown-plan",
    });
    expect(billingRouteSource).toContain("!isSafeProjection");
    expect(billingRouteSource).toContain("billing.configurationUnavailable");
  });

  it("presents purchased balance independently from pack purchase eligibility", () => {
    expect(billingRouteSource).toContain('i18n.t("billing.purchasedRecoveryCredits"');
    expect(billingRouteSource).toContain("recoveryCreditPackPurchaseEligible && recoveryCreditPackEnabled");
    expect(billingRouteSource.indexOf('i18n.t("billing.purchasedRecoveryCredits"')).toBeLessThan(
      billingRouteSource.indexOf("recoveryCreditPackPurchaseEligible && recoveryCreditPackEnabled"),
    );
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
        available: 80,
      },
      recoveryCreditPackEnabled: true,
      recoveryCreditsPerPack: 100,
      recoveryCreditPackMeter: "credit-pack-meter",
      recoveryCreditPackMeterVerified: true,
      recoveryCreditPackPurchaseEligible: false,
    });

    const result = await loader({ request: new Request("https://example.test/app/billing") } as never);

    expect(result).toMatchObject({
      purchasedRecoveryCredits: { available: 80 },
      recoveryCreditPackPurchaseEligible: false,
    });
    expect(billingRouteSource).toContain("recoveryCreditPackPurchaseEligible &&");
  });

  it("maps known billing codes once and leaves unknown codes non-actionable", () => {
    expect(getMerchantSystemMessageAction("BILLING_FREE_ALLOWANCE_WARNING")).toEqual({
      href: "/app/billing/select",
      labelKey: "billing.viewPlans",
    });
    expect(getMerchantSystemMessageAction("BILLING_FREE_ALLOWANCE_EXHAUSTED")).toEqual({
      href: "/app/billing/select",
      labelKey: "billing.upgradePlan",
    });
    expect(getMerchantSystemMessageAction("BILLING_SAFETY_LIMIT_REACHED")).toEqual({
      href: "/app/billing",
      labelKey: "billing.viewPlans",
    });
    expect(getMerchantSystemMessageAction("UNKNOWN_BILLING_CODE")).toBeNull();
  });
});
