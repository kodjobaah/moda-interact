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

/**
 * The theme app extension uid from
 * `extensions/moda-whatsapp-consent/shopify.extension.toml`. Published JSON
 * templates reference app blocks as
 * `shopify://apps/<app>/blocks/<handle>/<extension uid>`, so requiring this
 * uid prevents classifying another app's same-named `cart-consent` block as
 * Moda's.
 */
export const CART_CONSENT_EXTENSION_UID =
  "7ca38723-5155-90c1-190f-fd86e58b48b4650b0b05";

function isModaCartConsentBlockType(type: unknown): boolean {
  return (
    typeof type === "string" &&
    type.includes("/blocks/cart-consent/") &&
    type.includes(CART_CONSENT_EXTENSION_UID)
  );
}

/**
 * Derives App Block evidence from a published theme's `templates/cart.json`
 * body. A missing or non-JSON cart template means the published theme cannot
 * host the cart App Block (vintage/non-OS2.0 cart). Only Moda's own
 * `cart-consent` block counts, and blocks under a disabled ancestor section
 * are not treated as enabled.
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
    // A disabled section or block disables its whole subtree.
    if (record.disabled === true) return;
    if (isModaCartConsentBlockType(record.type)) {
      enabled = true;
      return;
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(parsed);

  return { cartTemplateSupported: true, blockEnabledInPublishedTheme: enabled };
}

export const PLUS_CHECKOUT_EXTENSION_HANDLE = "moda-whatsapp-checkout-consent";
export const PLUS_CHECKOUT_EXTENSION_TARGET =
  "purchase.checkout.contact.render-after";

/**
 * Classifies the read-only App Bridge `shopify.app.extensions()` result as
 * published-placement evidence for the Plus checkout consent extension.
 *
 * - entry with our handle, `ui_extension` type and a published activation at
 *   the contact target => `active`;
 * - successfully queried list without our handle at all => `inactive`;
 * - our handle present but without a verifiable published activation at the
 *   required target (or a malformed list) => `unverified`.
 *
 * This is placement evidence only; it never proves a shopper session or
 * attribute write (S004 owns those semantics).
 */
export function matchPlusCheckoutExtensionEvidence(
  extensions: unknown,
): "active" | "inactive" | "unverified" {
  if (!Array.isArray(extensions)) return "unverified";
  let sawHandle = false;
  for (const entry of extensions) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const handle = record.handle ?? record.name;
    if (handle !== PLUS_CHECKOUT_EXTENSION_HANDLE) continue;
    sawHandle = true;
    if (record.type !== "ui_extension") continue;
    const activations: unknown[] = [];
    for (const key of ["activations", "extensionPoints", "targets"]) {
      const value = record[key];
      if (Array.isArray(value)) activations.push(...value);
    }
    for (const activation of activations) {
      if (!activation || typeof activation !== "object") continue;
      const point = activation as Record<string, unknown>;
      const target = point.target ?? point.name;
      if (target !== PLUS_CHECKOUT_EXTENSION_TARGET) continue;
      if (point.published === false || point.draft === true) continue;
      return "active";
    }
  }
  return sawHandle ? "unverified" : "inactive";
}
