import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import SubscriptionChangePanel from "../../app/components/dashboard/SubscriptionChangePanel";

const merchantUi = { locale: "en-GB", fallbackLocale: "en", timeZone: "UTC" };
const current = {
  shopifyPlanHandle: "growth",
  mappedModaPlanName: "Growth",
  price: { amount: "75.00", currency: "GBP" },
  interval: "EVERY_30_DAYS",
  cancelAtEndOfCycle: true,
};
const pending = {
  shopifyPlanHandle: "starter",
  mappedModaPlanName: "Starter",
  price: { amount: "35.00", currency: "GBP" },
  effectiveAt: "2026-10-01T00:00:00.000Z",
};

function render(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SubscriptionChangePanel
        merchantUi={merchantUi}
        current={current}
        pending={pending}
        providerVerificationState="ACTIVE_SUBSCRIPTION"
        managePlansHref="/app/billing/select"
        managePlansAvailable
        {...overrides}
      />
    </MemoryRouter>,
  );
}

describe("SubscriptionChangePanel", () => {
  it("renders provider current and pending commercial facts separately", () => {
    const markup = render();
    expect(markup).toContain("growth");
    expect(markup).toContain("75.00");
    expect(markup).toContain("£75.00");
    expect(markup).not.toContain("EVERY_30_DAYS");
    expect(markup).toContain("per month");
    expect(markup).toContain("Current plan");
    expect(markup).toContain("starter");
    expect(markup).toContain("35.00");
    expect(markup).toContain("2026");
    expect(markup).toContain("Growth");
    expect(markup).toContain("Starter");
  });


  it("does not repeat the mapped current plan name", () => {
    const markup = render({ pending: null });
    expect(markup.match(/Growth/g)).toHaveLength(1);
  });

  it("keeps cancellation distinct from a pending provider update", () => {
    const markup = render();
    expect(markup).not.toContain("end at the end of the current billing period");
    expect(markup).toContain("starter");
  });

  it("renders unmapped current contracts and verification states distinctly", () => {
    const unmapped = render({ current: { ...current, mappedModaPlanName: null } });
    expect(unmapped).toContain("Billing configuration unavailable");
    expect(unmapped).toContain("growth");

    const noActive = render({ providerVerificationState: "NO_ACTIVE_SUBSCRIPTION", current: null, pending: null });
    expect(noActive).toContain("plans");

    const unavailable = render({ providerVerificationState: "VERIFICATION_UNAVAILABLE", current: null, pending: null });
    expect(unavailable).toContain("verify your current Shopify billing details");
    expect(unavailable).not.toContain("safely mapped");
  });

  it("does not invent a currency when the provider omits it", () => {
    const markup = render({
      current: { ...current, price: { amount: "75.00", currency: null } },
      pending: null,
    });
    expect(markup).toContain("75.00");
    expect(markup).toContain("configuration");
    expect(markup).not.toContain("GBP");
  });

  it("uses only the supplied hosted plan-management destination", () => {
    const markup = render();
    expect(markup).toContain('href="/app/billing/select"');
    expect(markup).not.toContain('target="_top"');
    expect(markup).not.toContain("moda-interact-admin");
  });

  it("renders an unconfirmed hosted selection without commercial facts", () => {
    const markup = render({
      pending: null,
      requestedSelection: { shopifyPlanHandle: "scale" },
    });
    expect(markup).toContain("scale");
    expect(markup).toContain("Waiting for confirmation from Shopify.");
    expect(markup).toContain("moda-provider-plan-awaiting-confirmation");
    const requestedCard = markup.slice(markup.indexOf("moda-provider-plan-awaiting-confirmation"));
    expect(requestedCard).not.toContain("£75.00");
    expect(requestedCard).not.toContain("EVERY_30_DAYS");
  });

  it("uses React Router navigation for the embedded transition route", async () => {
    const markup = render({ pending: null });
    expect(markup).toContain('href="/app/billing/select"');
    expect(markup).not.toContain('target="_top"');
    expect(markup).toContain("Change plan");
    expect(markup).toContain("moda-plan-actions");

    const source = await readFile(new URL("../../app/components/dashboard/SubscriptionChangePanel.jsx", import.meta.url), "utf8");
    expect(source).toContain('import { Link } from "react-router"');
    expect(source).toContain('<Link className="moda-action-button moda-action-button-primary" to={managePlansHref}>');
    expect(source).not.toContain('<a className="moda-action-button moda-action-button-primary"');
  });

  it("contains no local catalogue, rank inference, or provider mutation", async () => {
    const source = await readFile(new URL("../../app/components/dashboard/SubscriptionChangePanel.jsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/plans\[\]|isUpgrade|isDowngrade|upgradeAction|downgradeAction|appSubscriptionCreate|billing\.request|console\./);
  });
});