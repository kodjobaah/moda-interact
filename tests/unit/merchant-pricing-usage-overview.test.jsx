/* eslint-disable react/prop-types -- Simple router test doubles. */
import React from "react";
import { overviewFixture } from "../fixtures/recovery-overview";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-router", () => ({
  Link: ({ to, children, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Form: ({ children }) => <form>{children}</form>,
  useNavigate: () => vi.fn(),
  useRevalidator: () => ({ state: "idle", revalidate: vi.fn() }),
}));
vi.mock("../../app/components/dashboard/Breadcrumbs", () => ({
  default: () => null,
}));
vi.mock("../../app/components/dashboard/PendingRecoveries", () => ({
  default: () => null,
}));
vi.mock("../../app/components/dashboard/LifecycleRestrictionBanner", () => ({
  default: () => null,
}));

const { default: UsageOverview } =
  await import("../../app/components/dashboard/RecoveryOverview");

void React;

const merchantUi = { locale: "en-GB", timeZone: "UTC" };
const baseProps = {
  ...overviewFixture(),
  usageSummary: { current: [], past: [] },
  billingPeriods: [],
  pendingRecoveries: { available: false, items: [] },
  merchantUi,
  subscription: { status: "NO_CONTRACT" },
  capacity: { availability: "CONTRACT_REQUIRED" },
};
const pricingCatalogue = [
  {
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
  },
];

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
    expect(markup).not.toContain('href="/app/billing/options?');
  });

  it("fails closed without either billing action for an empty NO_CONTRACT catalogue", () => {
    const markup = renderState("NO_CONTRACT", []);

    expect(markup).toContain("Pricing is currently unavailable.");
    expect(markup).not.toContain('href="/app/billing/select"');
    expect(markup).not.toContain('href="/app/billing/options?');
  });

  it("suppresses plan-selection actions while billing setup is still reconciling", () => {
    const markup = renderToStaticMarkup(
      <UsageOverview
        {...baseProps}
        merchantExperienceState="BILLING_ATTENTION"
        pricingCatalogue={pricingCatalogue}
        billingSetup={{
          phase: "FINALIZING_SUBSCRIPTION",
          planHandle: "database-plan",
          planName: "Database Plan",
          currentPeriodStart: "2026-09-01T00:00:00.000Z",
          currentPeriodEnd: "2026-10-01T00:00:00.000Z",
          lastSyncedAt: "2026-09-18T21:45:40.710Z",
        }}
      />,
    );

    expect(markup).toContain("Your Shopify subscription is confirmed");
    expect(markup).toContain("Database Plan");
    expect(markup).not.toContain('href="/app/billing/select"');
    expect(markup).not.toContain('href="/app/billing/options?');
  });

  it.each(["ACTIVE", "FROZEN"])("preserves plan management for %s", (state) => {
    const markup = renderState(state);

    expect(markup).toContain('href="/app/billing/options?');
    expect(markup).not.toContain("mi-pricing-catalogue-card");
  });
});
