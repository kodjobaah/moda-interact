import { describe, expect, it } from "vitest";
import {
  canRenderConsent,
  CONSENT_ATTRIBUTE_KEY,
  isConsentStatus,
  readConsentReceipt,
} from "../../extensions/moda-whatsapp-checkout-consent/src/consent.js";

describe("Plus checkout WhatsApp consent extension helpers", () => {
  it("reads only one bounded current receipt from the checkout attribute", () => {
    expect(readConsentReceipt([])).toBeNull();
    expect(readConsentReceipt([
      { key: "other", value: "ignored" },
      { key: CONSENT_ATTRIBUTE_KEY, value: "signed-receipt" },
    ])).toBe("signed-receipt");
  });

  it("fails closed for malformed or duplicate consent attributes", () => {
    expect(readConsentReceipt(undefined)).toBeUndefined();
    expect(readConsentReceipt([
      { key: CONSENT_ATTRIBUTE_KEY, value: "one" },
      { key: CONSENT_ATTRIBUTE_KEY, value: "two" },
    ])).toBeUndefined();
    expect(readConsentReceipt([
      { key: CONSENT_ATTRIBUTE_KEY, value: "" },
    ])).toBeUndefined();
    expect(readConsentReceipt([
      { key: CONSENT_ATTRIBUTE_KEY, value: "x".repeat(513) },
    ])).toBeUndefined();
  });

  it("renders only on the supported contact target with a token and writable attributes", () => {
    expect(canRenderConsent({
      target: "purchase.checkout.contact.render-after",
      checkoutToken: "checkout-token",
      canUpdateAttributes: true,
    })).toBe(true);
    expect(canRenderConsent({
      target: "purchase.checkout.block.render",
      checkoutToken: "checkout-token",
      canUpdateAttributes: true,
    })).toBe(false);
    expect(canRenderConsent({
      target: "purchase.checkout.contact.render-after",
      checkoutToken: undefined,
      canUpdateAttributes: true,
    })).toBe(false);
    expect(canRenderConsent({
      target: "purchase.checkout.contact.render-after",
      checkoutToken: "checkout-token",
      canUpdateAttributes: false,
    })).toBe(false);
  });

  it("accepts only a well-shaped server status", () => {
    expect(isConsentStatus({ checked: true, source: "checkout" })).toBe(true);
    expect(isConsentStatus({ checked: false, source: "postgresql" })).toBe(true);
    expect(isConsentStatus({ checked: false, decision: "UNKNOWN", source: "invalid_checkout_receipt" })).toBe(true);
    expect(isConsentStatus({ checked: true, decision: "UNKNOWN", source: "invalid_checkout_receipt" })).toBe(false);
    expect(isConsentStatus({ checked: false, decision: "GRANTED", source: "invalid_checkout_receipt" })).toBe(false);
    expect(isConsentStatus({ checked: "true", source: "checkout" })).toBe(false);
    expect(isConsentStatus({ checked: true, source: "client" })).toBe(false);
  });
});
