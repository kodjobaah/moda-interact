export type ShopifyConsentPlacement =
  "non_plus_cart" | "plus_checkout" | "unknown";

export const CART_CONSENT_APP_DATA_METAFIELD = {
  namespace: "moda_interact",
  key: "cart_consent_enabled",
} as const;

type ThemeActivationUrlInput = Readonly<{
  shopDomain: string;
  apiKey: string;
  placement: ShopifyConsentPlacement;
}>;

/** Safe editor link: never inserts an additional block on repeat visits. */
export function buildCartConsentThemeEditorUrl(
  input: Pick<ThemeActivationUrlInput, "shopDomain" | "placement">,
): string | null {
  if (input.placement !== "non_plus_cart") return null;
  const url = new URL(
    `https://${input.shopDomain}/admin/themes/current/editor`,
  );
  url.searchParams.set("template", "cart");
  return url.toString();
}

export function buildCartConsentThemeActivationUrl(
  input: ThemeActivationUrlInput,
): string | null {
  if (input.placement !== "non_plus_cart") return null;

  const editorUrl = buildCartConsentThemeEditorUrl(input);
  if (!editorUrl) return null;
  const url = new URL(editorUrl);
  url.searchParams.set("addAppBlockId", `${input.apiKey}/cart-consent`);
  url.searchParams.set("target", "newAppsSection");
  return url.toString();
}

/** One-click Shopify App Embed enablement; merchant must still Save the theme. */
export function buildCartDrawerConsentThemeActivationUrl(
  input: ThemeActivationUrlInput,
): string | null {
  if (
    input.placement !== "non_plus_cart" ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(input.shopDomain) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.apiKey)
  )
    return null;
  const url = new URL(
    `https://${input.shopDomain}/admin/themes/current/editor`,
  );
  url.searchParams.set("context", "apps");
  url.searchParams.set("template", "cart");
  url.searchParams.set("activateAppId", `${input.apiKey}/cart-drawer-consent`);
  return url.toString();
}
