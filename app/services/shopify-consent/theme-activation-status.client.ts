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
