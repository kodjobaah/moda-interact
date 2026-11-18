export type ShopifyConsentPlacement = "non_plus_cart" | "plus_checkout" | "unknown";

export const CART_CONSENT_APP_DATA_METAFIELD = {
  namespace: "moda_interact",
  key: "cart_consent_enabled",
} as const;

type ThemeActivationUrlInput = Readonly<{
  shopDomain: string;
  apiKey: string;
  placement: ShopifyConsentPlacement;
}>;

const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function buildCartConsentThemeActivationUrl(
  input: ThemeActivationUrlInput,
): string | null {
  if (input.placement !== "non_plus_cart") return null;
  if (!SHOP_DOMAIN_PATTERN.test(input.shopDomain)) {
    throw new TypeError("A valid Shopify shop domain is required.");
  }
  if (!API_KEY_PATTERN.test(input.apiKey)) {
    throw new TypeError("A valid Shopify app API key is required.");
  }

  const url = new URL(`https://${input.shopDomain}/admin/themes/current/editor`);
  url.searchParams.set("template", "cart");
  url.searchParams.set("addAppBlockId", `${input.apiKey}/cart-consent`);
  url.searchParams.set("target", "newAppsSection");
  return url.toString();
}
