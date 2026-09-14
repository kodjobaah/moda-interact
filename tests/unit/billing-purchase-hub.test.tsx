import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import BillingPurchaseHub from "../../app/components/dashboard/BillingPurchaseHub";

vi.mock("../../app/components/dashboard/TopUpPurchasePanel", () => ({
  default: () => null,
}));

const merchantUi = { locale: "en-GB", fallbackLocale: "en", timeZone: "UTC" };
const topUpState = {
  configured: true,
  purchaseEligible: true,
  creditsPerPack: 10,
  purchasedCreditsAvailable: 4,
  latestPurchase: null,
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
      managePlansHref="/app/billing/select"
      managePlansAvailable
      onPurchaseTopUp={() => {}}
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

  it("renders Shopify verification failure distinctly from an unmapped plan", () => {
    const markup = render({ verificationState: "VERIFICATION_UNAVAILABLE", current: null });
    expect(markup).toContain("verify your current Shopify billing details");
    expect(markup).not.toContain("Your subscription could not be safely mapped");
  });

  it("explains a configured but unverifiable Free top-up", () => {
    const markup = render({
      capacity: { freeLifetime: { granted: 10, remaining: 7 }, purchased: { available: 0 }, promotional: { remaining: 0 } },
      verificationState: "ACTIVE_SUBSCRIPTION",
      current: { shopifyPlanHandle: "free", mappedModaPlanName: "Free" },
      billingPeriodPhase: null,
      topUpState: { ...topUpState, purchaseEligible: false },
    });
    expect(markup).toContain("Top-up purchase is unavailable until the current billing cycle and recovery-credit meter are verified.");
    expect(markup).not.toContain(">Buy</button>");
  });

  it("does not fabricate zero balances when capacity is unavailable", () => {
    const markup = render({ capacity: null });
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("Included recoveries this period: 0");
    expect(markup).not.toContain("Lifetime Free recoveries: 0");
    expect(markup).not.toContain("Promotional recoveries available</span>");
    expect(markup).not.toContain("purchased credits available</span>");
  });
});