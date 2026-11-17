export const CONSENT_ATTRIBUTE_KEY = "moda_wa_consent_v1";
export const CHECKOUT_TARGET = "purchase.checkout.contact.render-after";
export const CHECKOUT_RECEIPT_ENDPOINT =
  "https://app-test.modainteract.com/shopify/checkout/receipt";

export function readConsentReceipt(attributes) {
  if (!Array.isArray(attributes)) return undefined;
  const matches = attributes.filter(
    (attribute) =>
      attribute &&
      typeof attribute === "object" &&
      !Array.isArray(attribute) &&
      attribute.key === CONSENT_ATTRIBUTE_KEY,
  );
  if (matches.length === 0) return null;
  if (
    matches.length !== 1 ||
    typeof matches[0].value !== "string" ||
    matches[0].value.length === 0 ||
    matches[0].value.length > 512
  ) {
    return undefined;
  }
  return matches[0].value;
}

export function canRenderConsent({ target, checkoutToken, canUpdateAttributes }) {
  return (
    target === CHECKOUT_TARGET &&
    typeof checkoutToken === "string" &&
    checkoutToken.length > 0 &&
    canUpdateAttributes === true
  );
}

export function isConsentStatus(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.checked === "boolean" &&
    (value.source === "checkout" || value.source === "postgresql")
  );
}
