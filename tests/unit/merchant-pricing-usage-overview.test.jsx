import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-router", () => ({
  Link: (props) => <a {...props}>link</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("../../app/components/dashboard/Breadcrumbs", () => ({ default: () => null }));
vi.mock("../../app/components/dashboard/PendingRecoveries", () => ({ default: () => null }));
vi.mock("../../app/components/dashboard/LifecycleRestrictionBanner", () => ({ default: () => null }));

const { default: UsageOverview } = await import("../../app/components/dashboard/UsageOverview");

void React;

const merchantUi = { locale: "en-GB", timeZone: "UTC" };
const baseProps = {
  usageSummary: { current: [], past: [] },
  billingPeriods: [],
  pendingRecoveries: { available: false, items: [] },
  merchantUi,
  subscription: { status: "NO_CONTRACT" },
  capacity: { availability: "CONTRACT_REQUIRED" },
};
const pricingCatalogue = [{
  shopifyPlanHandle: "database-plan",
  displayName: "Database Plan",
  planKind: "PAID_METERED",
  featured: false,
  localizedDescription: "Database description",
  includedRecoveryCredits: 42,
  allowancePeriod: "EVERY_30_DAYS",
  billingPeriod: "EVERY_30_DAYS",
  recurringAmountMinor: 3500,
  currency: "GBP",
  highlights: [],
}];

function renderState(merchantExperienceState, catalogue = pricingCatalogue) {
  return renderToStaticMarkup(
    <UsageOverview
      {...baseProps}
      merchantExperienceState={merchantExperienceState}
      pricingCatalogue={catalogue}
    />,
  );
}

describe("UsageOverview merchant pricing state", () => {
  it("renders the catalogue and select action for NO_CONTRACT", () => {
    const markup = renderState("NO_CONTRACT");

    expect(markup).toContain("Database Plan");
    expect(markup).toContain('href="/app/billing/select"');
    expect(markup).not.toContain('href="/app/billing/options"');
  });

  it("fails closed without either billing action for an empty NO_CONTRACT catalogue", () => {
    const markup = renderState("NO_CONTRACT", []);

    expect(markup).toContain("Pricing is currently unavailable.");
    expect(markup).not.toContain('href="/app/billing/select"');
    expect(markup).not.toContain('href="/app/billing/options"');
  });

  it.each(["ACTIVE", "FROZEN"])("preserves plan management for %s", (state) => {
    const markup = renderState(state);

    expect(markup).toContain('href="/app/billing/options"');
    expect(markup).not.toContain("mi-pricing-catalogue-card");
  });
});