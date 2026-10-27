import { describe, expect, it } from "vitest";

import {
  getMerchantSystemMessageAction,
  getRecoverySupportMessageAction,
} from "../../app/services/merchant-support/system-message-actions";

const base = {
  systemCode: "RECOVERY_INITIAL_OUTREACH_SENT",
  systemVersion: "1",
  checkoutRecoveryId: "recovery-1",
  merchantExperienceState: "ACTIVE" as const,
};

describe("recovery Support message action", () => {
  it("builds an encoded first-party transcript link for an accessible recovery", () => {
    expect(getRecoverySupportMessageAction({
      ...base,
      checkoutRecoveryId: "recovery ?#1",
    })).toEqual({
      href: "/app/recoveries/recovery%20%3F%231#recovery-conversation",
      labelKey: "support.viewRecoveryConversation",
    });
  });

  it.each(["SUPPORT_ONLY", "REINSTALLING", "ONBOARDING", "SIGNED_OUT"] as const)(
    "does not expose recovery history to %s",
    (merchantExperienceState) => {
      expect(getRecoverySupportMessageAction({ ...base, merchantExperienceState })).toBeNull();
    },
  );

  it.each([
    { systemCode: "BILLING_PLAN_UPGRADED" },
    { systemVersion: "2" },
    { checkoutRecoveryId: null },
    { checkoutRecoveryId: "" },
    { checkoutRecoveryId: "../foreign" },
    { checkoutRecoveryId: "foreign\\recovery" },
    { checkoutRecoveryId: "x".repeat(192) },
  ])("rejects an untrusted recovery notice target: %o", (override) => {
    expect(getRecoverySupportMessageAction({ ...base, ...override })).toBeNull();
  });

  it("leaves existing billing action mappings unchanged", () => {
    expect(getMerchantSystemMessageAction("BILLING_SAFETY_LIMIT_REACHED", "ACTIVE")).toEqual({
      href: "/app/billing/options",
      labelKey: "billing.viewPlans",
    });
  });
});
