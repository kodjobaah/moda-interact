export type ThemeActivationEvidence = Readonly<{
  placement: "non_plus_cart" | "plus_checkout" | "unknown";
  publishedThemeAvailable: boolean | null;
  cartTemplateSupported: boolean | null;
  blockEnabledInPublishedTheme: boolean | null;
}>;

export type ThemeActivationStatus =
  | "active"
  | "inactive"
  | "unsupported"
  | "unavailable"
  | "unverified";

export function getCartConsentThemeActivationStatus(
  evidence: ThemeActivationEvidence,
): ThemeActivationStatus {
  if (evidence.placement === "plus_checkout") return "unsupported";
  if (evidence.publishedThemeAvailable === false) return "unavailable";
  if (evidence.cartTemplateSupported === false) return "unsupported";
  if (
    evidence.placement !== "non_plus_cart" ||
    evidence.publishedThemeAvailable !== true ||
    evidence.cartTemplateSupported !== true ||
    typeof evidence.blockEnabledInPublishedTheme !== "boolean"
  ) {
    return "unverified";
  }
  return evidence.blockEnabledInPublishedTheme ? "active" : "inactive";
}

export type PlusCheckoutActivationEvidence = Readonly<{
  placement: "non_plus_cart" | "plus_checkout" | "unknown";
  extensionVerified: boolean | null;
}>;

/**
 * Status of the Plus checkout consent extension placement. The cart App Block
 * is the only placement on non-Plus plans, so Plus checkout is `unsupported`
 * there; without positive verification evidence the status stays truthful
 * (`unverified`/`unavailable`) rather than inventing an enabled badge.
 */
export function getPlusCheckoutConsentActivationStatus(
  evidence: PlusCheckoutActivationEvidence,
): ThemeActivationStatus {
  if (evidence.placement === "non_plus_cart") return "unsupported";
  if (evidence.placement !== "plus_checkout") return "unavailable";
  if (evidence.extensionVerified === true) return "active";
  return "unverified";
}

export type CartTemplateEvidence = Readonly<{
  cartTemplateSupported: boolean | null;
  blockEnabledInPublishedTheme: boolean | null;
}>;

const CART_CONSENT_BLOCK_TYPE_PATTERN = /\/blocks\/cart-consent\//;

/**
 * Derives App Block evidence from a published theme's `templates/cart.json`
 * body. A missing or non-JSON cart template means the published theme cannot
 * host the cart App Block (vintage/non-OS2.0 cart).
 */
export function deriveCartTemplateEvidence(
  cartTemplateContent: string | null,
): CartTemplateEvidence {
  if (cartTemplateContent === null) {
    return { cartTemplateSupported: false, blockEnabledInPublishedTheme: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cartTemplateContent);
  } catch {
    return { cartTemplateSupported: false, blockEnabledInPublishedTheme: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { cartTemplateSupported: false, blockEnabledInPublishedTheme: null };
  }

  let enabled = false;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (
      typeof record.type === "string" &&
      CART_CONSENT_BLOCK_TYPE_PATTERN.test(record.type) &&
      record.disabled !== true
    ) {
      enabled = true;
      return;
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(parsed);

  return { cartTemplateSupported: true, blockEnabledInPublishedTheme: enabled };
}
