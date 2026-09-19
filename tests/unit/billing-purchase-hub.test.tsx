import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useSubmit: () => vi.fn() };
});

import BillingPurchaseHub from "../../app/components/dashboard/BillingPurchaseHub";

const merchantUi = { locale: "en-GB", fallbackLocale: "en", timeZone: "UTC" };
const topUpState = {
  configured: true,
  purchaseEligible: true,
  offers: [],
  offerVerificationState: "VERIFIED",
  purchasedCreditsAvailable: 4,
  latestPurchase: null,
  unresolvedPurchases: [],
};

function render(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <BillingPurchaseHub
      merchantUi={merchantUi}
      capacity={{
        paidIncluded: { granted: 30, remaining: 21 },
        freeLifetime: { granted: 10, remaining: 7 },
        promotional: { remaining: 2 },
        purchased: { available: 4 },
      }}
      lifecycleState="ACTIVE"
      verificationState="ACTIVE_SUBSCRIPTION"
      mappingStatus="MAPPED"
      topUpState={topUpState}
      current={{ shopifyPlanHandle: "growth", mappedModaPlanName: "Growth" }}
      pending={null}
      purchaseHistoryAvailable
      managePlansHref="/app/billing/select"
      managePlansAvailable
      {...overrides}
    />,
  );
}

describe("BillingPurchaseHub", () => {
  it("renders Paid included and lifetime Free as separate balances", () => {
    const markup = render();
    expect(markup).toContain("Included recoveries this period: 21 of 30 remaining");
    expect(markup).toContain("Lifetime Free recoveries: 7 of 10 remaining");
  });

  it("preserves the durable current plan while Shopify verification is temporarily unavailable", () => {
    const markup = render({
      verificationState: "VERIFICATION_UNAVAILABLE",
      current: { shopifyPlanHandle: "free", mappedModaPlanName: "Free", price: null, interval: null, cancelAtEndOfCycle: false },
      managePlansAvailable: false,
    });
    expect(markup).toContain("verify your current Shopify billing details");
    expect(markup).toContain(">Free<");
    expect(markup).not.toContain("Your subscription could not be safely mapped");
  });

  it("explains a configured but unverifiable Free top-up", () => {
    const markup = render({
      capacity: { freeLifetime: { granted: 10, remaining: 7 }, purchased: { available: 0 }, promotional: { remaining: 0 } },
      verificationState: "ACTIVE_SUBSCRIPTION",
      current: { shopifyPlanHandle: "free", mappedModaPlanName: "Free" },
      billingPeriodPhase: null,
      topUpState: { ...topUpState, purchaseEligible: false, offerVerificationState: "VERIFICATION_UNAVAILABLE" },
    });
    expect(markup).toContain("We couldn&#x27;t verify top-up availability right now. Please try again later.");
    expect(markup).not.toContain(">Buy</button>");
  });

  it("does not fabricate zero balances when capacity is unavailable", () => {
    const markup = render({ capacity: null });
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("Included recoveries this period: 0");
    expect(markup).not.toContain("Lifetime Free recoveries: 0");
    expect(markup).not.toContain("Promotional recoveries available</span>");
  });

  it("warns for a genuine UNMAPPED subscription without hiding independent balances", () => {
    const markup = render({ mappingStatus: "UNMAPPED", topUpState: { ...topUpState, configured: false, purchaseEligible: false, creditsPerPack: null, shopifyPackMeter: null } });
    expect(markup).toContain("Your subscription could not be safely mapped");
    expect(markup).toContain("Growth");
    expect(markup).toContain("Included recoveries this period: 21 of 30 remaining");
    expect(markup).toContain("Manage purchased credits");
  });

  it("renders the purchased-credit history link when the policy allows it", () => {
    const markup = render({ purchaseHistoryAvailable: true });
    expect(markup).toContain('href="/app/billing/recovery-credit-purchases"');
    expect(markup).toContain("Manage purchased credits");
  });

  it("hides the purchased-credit history link when the policy denies it", () => {
    const markup = render({ purchaseHistoryAvailable: false });
    expect(markup).not.toContain('href="/app/billing/recovery-credit-purchases"');
    expect(markup).not.toContain("Manage purchased credits");
  });

  it("renders one resolved offer with its selected handle", () => {
    const markup = render({
      topUpState: {
        ...topUpState,
        offers: [{
          eventHandle: "recovery-small",
          cataloguePosition: 0,
          creditsGranted: 10,
          providerPrice: { currency: "USD", tiers: [{ amountPerUnit: "4.00" }] },
          providerUsage: null,
        }],
      },
    });
    expect(markup).toContain("10");
    expect(markup).toContain('class="moda-topup-grid"');
    expect(markup).toContain('class="moda-action-button moda-action-button-primary moda-topup-buy-button"');
    expect(markup).toContain('aria-label="Buy 10 recovery conversations"');
    expect(markup).toContain(">Buy</button>");
    expect(markup).toContain('name="eventHandle" value="recovery-small"');
  });



  it("disables only the offer with an unresolved purchase", () => {
    const markup = render({
      topUpState: {
        ...topUpState,
        offers: [
          { eventHandle: "bronze-top-up-free", cataloguePosition: 0, creditsGranted: 1, providerPrice: { currency: "USD", tiers: [{ amountPerUnit: "0.00" }] }, providerUsage: null },
          { eventHandle: "silver-top-up", cataloguePosition: 1, creditsGranted: 2, providerPrice: { currency: "USD", tiers: [{ amountPerUnit: "0.00" }] }, providerUsage: null },
          { eventHandle: "gold-top-up", cataloguePosition: 2, creditsGranted: 3, providerPrice: { currency: "USD", tiers: [{ amountPerUnit: "0.00" }] }, providerUsage: null },
        ],
        unresolvedPurchases: [{
          eventHandle: "bronze-top-up-free",
          creditsGranted: 1,
          usageReportState: "REPORTED",
        }],
      },
    });

    const bronzeButton = markup.match(/aria-label="Buy 1 recovery conversations"[^>]*>/)?.[0] ?? "";
    const silverButton = markup.match(/aria-label="Buy 2 recovery conversations"[^>]*>/)?.[0] ?? "";
    const goldButton = markup.match(/aria-label="Buy 3 recovery conversations"[^>]*>/)?.[0] ?? "";

    expect(bronzeButton).toContain("disabled");
    expect(silverButton).not.toContain("disabled");
    expect(goldButton).not.toContain("disabled");
    expect(markup).toContain("Recovery credit purchase is being confirmed by Shopify.");
  });

  it("submits top-up purchases through React Router instead of a document POST", async () => {
    const source = await readFile(new URL("../../app/components/dashboard/TopUpPurchasePanel.jsx", import.meta.url), "utf8");
    expect(source).toContain('import { useSubmit } from "react-router"');
    expect(source).toContain("event.preventDefault()");
    expect(source).toContain('submit(formData, { method: "post" })');
    expect(source).toContain('formData.set("purchaseId", crypto.randomUUID())');
  });

  it("renders multiple resolved offers in catalogue order with selected handles", () => {
    const markup = render({
      topUpState: {
        ...topUpState,
        offers: [
          { eventHandle: "recovery-small", cataloguePosition: 0, creditsGranted: 10, providerPrice: { currency: "USD", tiers: [{ amountPerUnit: "4.00" }] }, providerUsage: null },
          { eventHandle: "recovery-large", cataloguePosition: 1, creditsGranted: 50, providerPrice: { currency: "USD", tiers: [{ amountPerUnit: "15.00" }] }, providerUsage: null },
        ],
      },
    });
    expect(markup.indexOf(">10<")).toBeLessThan(markup.indexOf(">50<"));
    expect(markup).toContain('name="eventHandle" value="recovery-small"');
    expect(markup).toContain('name="eventHandle" value="recovery-large"');
  });
});