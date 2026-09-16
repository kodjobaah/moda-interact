import { describe, expect, it } from "vitest";
import { activeDiscount, parseMerchantRecoveryPolicy } from "../../app/services/recovery-policy/recovery-policy.server";

describe("recovery policy validation", () => {
  it.each([
    [{ recoveryDelayMinutes: "0", recoveryOfferMode: "NONE", followUpEnabled: "false", followUpDelayMinutes: "" }],
    [{ recoveryDelayMinutes: "10080", recoveryOfferMode: "AI_BEST_APPLICABLE", followUpEnabled: "true", followUpDelayMinutes: "60" }],
  ])("accepts valid merchant snapshots", (input) => {
    expect(parseMerchantRecoveryPolicy(input)).toMatchObject({ source: "MERCHANT" });
  });

  it("requires a fixed discount only for FIXED mode", () => {
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "FIXED", followUpEnabled: "false" })).toThrow();
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", fixedShopifyDiscountId: "discount-1", followUpEnabled: "false" })).toThrow();
  });

  it("requires a delay for enabled follow-up and clears it when disabled", () => {
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", followUpEnabled: "true" })).toThrow();
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", followUpEnabled: "false", followUpDelayMinutes: "60" })).toThrow();
  });

  it("recognizes only currently selectable discounts", () => {
    const now = new Date("2026-09-16T12:00:00Z");
    expect(activeDiscount({ fixedSelectable: true, isAvailable: true, providerStatus: "ACTIVE", startsAt: null, endsAt: null }, now)).toBe(true);
    expect(activeDiscount({ fixedSelectable: false, isAvailable: true, providerStatus: "ACTIVE", startsAt: null, endsAt: null }, now)).toBe(false);
    expect(activeDiscount({ fixedSelectable: true, isAvailable: true, providerStatus: "ACTIVE", startsAt: new Date("2026-09-17T00:00:00Z"), endsAt: null }, now)).toBe(false);
  });
});