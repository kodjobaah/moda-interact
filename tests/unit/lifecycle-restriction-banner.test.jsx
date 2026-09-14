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
    expect(html).not.toContain("remains active until");
  });

  it("gives frozen state precedence and keeps contract-required state visible", () => {
    expect(renderBanner(
      { status: "ACTIVE", cancelAtEndOfCycle: true, currentPeriodEnd: "2026-10-01T00:00:00.000Z" },
      { availability: "CONTRACT_FROZEN", canStartRecovery: false },
    )).toContain("Subscription paused by Shopify");

    expect(renderBanner(
      { status: "NO_CONTRACT" },
      { availability: "CONTRACT_REQUIRED", canStartRecovery: false },
    )).toContain("Your subscription has ended");
  });
});