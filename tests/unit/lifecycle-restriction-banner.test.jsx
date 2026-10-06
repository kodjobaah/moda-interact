import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import LifecycleRestrictionBanner from "../../app/components/dashboard/LifecycleRestrictionBanner";

const merchantUi = { locale: "en-GB", timeZone: "UTC" };

function renderBanner(subscription, capacity) {
  return renderToStaticMarkup(
    <LifecycleRestrictionBanner
      merchantUi={merchantUi}
      subscription={subscription}
      capacity={capacity}
    />,
  );
}

describe("LifecycleRestrictionBanner", () => {
  it("keeps pending plan changes distinct from scheduled cancellation", () => {
    const html = renderBanner(
      {
        status: "ACTIVE",
        cancelAtEndOfCycle: true,
        currentPeriodEnd: "2026-10-01T00:00:00.000Z",
        pendingPlan: { name: "Basic", effectiveAt: "2026-09-20T00:00:00.000Z" },
      },
      { availability: "AVAILABLE" },
    );

    expect(html).toContain("Pending change to Basic");
    expect(html).not.toContain("scheduled to end");
  });


  it("keeps scheduled cancellation informational while top-ups remain available", () => {
    const html = renderBanner(
      {
        status: "ACTIVE",
        cancelAtEndOfCycle: true,
        currentPeriodEnd: "2026-10-19T00:00:00.000Z",
        pendingPlan: null,
      },
      { availability: "AVAILABLE" },
    );

    expect(html).toContain("subscription is scheduled to end");
    expect(html).toContain("top-ups normally available to it until then");
  });

  it("gives frozen state precedence and keeps never-subscribed contract-required state visible", () => {
    expect(renderBanner(
      { status: "ACTIVE", cancelAtEndOfCycle: true, currentPeriodEnd: "2026-10-01T00:00:00.000Z" },
      { availability: "CONTRACT_FROZEN", canStartRecovery: false },
    )).toContain("Subscription paused by Shopify");

    expect(renderBanner(
      { status: "NO_CONTRACT" },
      { availability: "CONTRACT_REQUIRED", canStartRecovery: false },
    )).toContain("Choose a Free or paid plan");
  });

  it("distinguishes post-contract credits from post-contract exhaustion", () => {
    expect(renderBanner(
      { status: "NO_CONTRACT" },
      { availability: "POST_CONTRACT_AVAILABLE", canStartRecovery: true },
    )).toContain("remaining purchased and lifetime Free recovery credits");

    expect(renderBanner(
      { status: "NO_CONTRACT" },
      { availability: "POST_CONTRACT_EXHAUSTED", canStartRecovery: false },
    )).toContain("no purchased or lifetime Free recovery credits remain");
  });
});