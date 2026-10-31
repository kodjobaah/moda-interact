import { describe, expect, it } from "vitest";
import { isCurrentlyRunning, parseMerchantRecoveryPolicy } from "../../app/services/recovery-policy/recovery-policy.server";

describe("recovery policy validation", () => {
  it.each([
    [{ recoveryDelayMinutes: "0", recoveryOfferMode: "NONE", selectedDiscountIds: [], followUpEnabled: "false", followUpDelayMinutes: "", notifyOnInitialRecoveryOutreach: false }],
    [{ recoveryDelayMinutes: "10080", recoveryOfferMode: "AI_BEST_APPLICABLE", selectedDiscountIds: [], followUpEnabled: "true", followUpDelayMinutes: "60", notifyOnInitialRecoveryOutreach: true }],
  ])("accepts valid merchant snapshots", (input) => {
    expect(parseMerchantRecoveryPolicy(input)).toMatchObject({ source: "MERCHANT" });
  });

  it("requires a fixed discount only for FIXED mode", () => {
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "FIXED", selectedDiscountIds: [], followUpEnabled: "false", notifyOnInitialRecoveryOutreach: false })).toThrow();
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", selectedDiscountIds: ["discount-1"], followUpEnabled: "false", notifyOnInitialRecoveryOutreach: false })).not.toThrow();
  });

  it("sorts selected IDs deterministically and rejects duplicates or more than 50", () => {
    expect(parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "FIXED", selectedDiscountIds: ["z", "a"], followUpEnabled: "false", notifyOnInitialRecoveryOutreach: false })).toMatchObject({ fixedShopifyDiscountId: "a", selectedDiscountIds: ["a", "z"] });
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", selectedDiscountIds: ["a", "a"], followUpEnabled: "false", notifyOnInitialRecoveryOutreach: false })).toThrow();
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", selectedDiscountIds: Array.from({ length: 51 }, (_, index) => String(index)), followUpEnabled: "false", notifyOnInitialRecoveryOutreach: false })).toThrow();
  });

  it("requires a delay for enabled follow-up and clears it when disabled", () => {
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", selectedDiscountIds: [], followUpEnabled: "true", notifyOnInitialRecoveryOutreach: false })).toThrow();
    expect(parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", selectedDiscountIds: [], followUpEnabled: "false", followUpDelayMinutes: "60", notifyOnInitialRecoveryOutreach: true })).toMatchObject({ followUpEnabled: false, followUpDelayMinutes: null });
  });

  it("requires a Boolean initial outreach notification preference", () => {
    expect(() => parseMerchantRecoveryPolicy({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", selectedDiscountIds: [], followUpEnabled: "false", notifyOnInitialRecoveryOutreach: "true" })).toThrow();
  });

  it("derives catalogue availability from provider status and time, not merchant selection", () => {
    const now = new Date("2026-09-16T12:00:00Z");
    expect(isCurrentlyRunning({ fixedSelectable: true, isAvailable: false, providerStatus: "ACTIVE", startsAt: null, endsAt: null }, now)).toBe(true);
    expect(isCurrentlyRunning({ fixedSelectable: true, isAvailable: true, providerStatus: "EXPIRED", startsAt: null, endsAt: null }, now)).toBe(false);
    expect(isCurrentlyRunning({ fixedSelectable: true, isAvailable: true, providerStatus: "ACTIVE", startsAt: new Date("2026-09-17T00:00:00Z"), endsAt: null }, now)).toBe(false);
  });
});