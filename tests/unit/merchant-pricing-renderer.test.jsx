import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MerchantPricingCatalogue from "../../app/components/merchant-pricing/MerchantPricingCatalogue";
import Onboarding from "../../app/components/onboarding/Onboarding";

void React;

const merchantUi = { locale: "en-GB", timeZone: "UTC" };

function render(pricingCatalogue) {
  return renderToStaticMarkup(<Onboarding merchantUi={merchantUi} pricingCatalogue={pricingCatalogue} />);
}

function renderCatalogue(pricingCatalogue, showChoosePlanAction = false) {
  return renderToStaticMarkup(<MerchantPricingCatalogue merchantUi={merchantUi} pricingCatalogue={pricingCatalogue} showChoosePlanAction={showChoosePlanAction} />);
}

const plan = {
  shopifyPlanHandle: "database-plan",
  displayName: "Database Plan",
  planKind: "PAID_METERED",
  cataloguePosition: 0,
  featured: true,
  localizedDescription: "Description from the pricing database.",
  includedRecoveryCredits: 42,
  allowancePeriod: "EVERY_30_DAYS",
  billingPeriod: "EVERY_30_DAYS",
  recurringAmountMinor: 3500,
  currency: "GBP",
  usageEvents: [
    {
      eventHandle: "fixed-internal-name",
      creditsGrantedPerUnit: 12,
      maximumUnitsPerBillingPeriod: 10,
      pricingMode: "FIXED",
      currency: "GBP",
      fixedUnitAmountMinor: 500,
      tiers: [],
    },
    {
      eventHandle: "graduated-internal-name",
      creditsGrantedPerUnit: 8,
      maximumUnitsPerBillingPeriod: null,
      pricingMode: "GRADUATED",
      currency: "GBP",
      fixedUnitAmountMinor: null,
      tiers: [
        { position: 0, upTo: 10, amountPerUnitMinor: 50, flatAmountMinor: 0 },
        { position: 1, upTo: null, amountPerUnitMinor: 25, flatAmountMinor: 100 },
      ],
    },
    {
      eventHandle: "volume-internal-name",
      creditsGrantedPerUnit: 6,
      maximumUnitsPerBillingPeriod: 20,
      pricingMode: "VOLUME",
      currency: "GBP",
      fixedUnitAmountMinor: null,
      tiers: [{ position: 0, upTo: null, amountPerUnitMinor: 20, flatAmountMinor: 0 }],
    },
  ],
  highlights: [
    { contentKey: "highlight-1", position: 0, title: "Localized highlight", description: "Admin-authored detail." },
  ],
};

describe("Onboarding merchant pricing renderer", () => {
  it("renders structured DTO card content and hides raw usage pricing mechanics", () => {
    const markup = render([plan]);

    expect(markup).toContain("Database Plan");
    expect(markup).toContain("Description from the pricing database.");
    expect(markup).toContain("mi-pricing-catalogue-card-featured");
    expect(markup).toContain("Localized highlight");
    expect(markup).toContain("Admin-authored detail.");
    expect(markup).toContain("£35");
    expect(markup).toContain("42");
    expect(markup).not.toContain("Fixed");
    expect(markup).not.toContain("Graduated");
    expect(markup).not.toContain("Volume");
    expect(markup).not.toContain("Amount per unit");
    expect(markup).not.toContain("Flat amount");
    expect(markup).not.toContain("fixed-internal-name");
    expect(markup).toContain('href="/app/billing/select"');
  });

  it("renders a generic unavailable state for an empty catalogue", () => {
    const markup = render([]);

    expect(markup).toContain("Pricing is currently unavailable.");
    expect(markup).not.toContain("Database Plan");
    expect(markup).not.toContain("£35");
  });

  it("keeps the reusable renderer in received order and gates its action on non-empty data", () => {
    const secondPlan = { ...plan, shopifyPlanHandle: "second", displayName: "Second plan", cataloguePosition: 1, featured: false };
    const markup = renderCatalogue([secondPlan, plan], true);

    expect(markup.indexOf("Second plan")).toBeLessThan(markup.indexOf("Database Plan"));
    expect(markup).toContain('href="/app/billing/select"');
    expect(renderCatalogue([], true)).not.toContain('href="/app/billing/select"');
  });

  it("omits the Free proof item when the active catalogue has no Free plan", () => {
    const markup = render([{ ...plan, planKind: "PAID_METERED" }]);

    expect(markup).not.toContain("free recovery conversations");
    expect(markup).not.toContain(">-</strong>");
  });
});
