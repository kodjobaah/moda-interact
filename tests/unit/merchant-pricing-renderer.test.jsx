import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Onboarding from "../../app/components/onboarding/Onboarding";

void React;

const merchantUi = { locale: "en-GB", timeZone: "UTC" };

function render(pricingCatalogue) {
  return renderToStaticMarkup(<Onboarding merchantUi={merchantUi} pricingCatalogue={pricingCatalogue} />);
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
};

describe("Onboarding merchant pricing renderer", () => {
  it("renders DTO names, descriptions, featured state, and every usage pricing mode", () => {
    const markup = render([plan]);

    expect(markup).toContain("Database Plan");
    expect(markup).toContain("Description from the pricing database.");
    expect(markup).toContain("mi-plan-card-featured");
    expect(markup).toContain("Fixed");
    expect(markup).toContain("Graduated");
    expect(markup).toContain("Volume");
    expect(markup).toContain("12 credits per unit");
    expect(markup).toContain("Amount per unit");
    expect(markup).toContain("Flat amount");
    expect(markup).not.toContain("fixed-internal-name");
    expect(markup).toContain('href="/app/billing/select"');
  });

  it("renders a generic unavailable state for an empty catalogue", () => {
    const markup = render([]);

    expect(markup).toContain("Pricing is currently unavailable.");
    expect(markup).not.toContain("Database Plan");
    expect(markup).not.toContain("£35");
  });

  it("omits the Free proof item when the active catalogue has no Free plan", () => {
    const markup = render([{ ...plan, planKind: "PAID_METERED" }]);

    expect(markup).not.toContain("free recovery conversations");
    expect(markup).not.toContain(">-</strong>");
  });
});
