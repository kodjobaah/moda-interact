/**
 * Scope observation only: a declaration in app TOML is not an installation grant.
 * The Shopify APP_SCOPES_UPDATE webhook reports the current grant, but Background
 * must independently verify its own shop's persisted OFFLINE session before
 * issuing any read_brand Admin GraphQL request.
 */
export type ShopifyBrandReadGrant = "GRANTED" | "MISSING";

export function shopifyBrandReadGrant(
  grantedScopes: string | readonly string[] | null | undefined,
): ShopifyBrandReadGrant {
  const scopes = typeof grantedScopes === "string"
    ? grantedScopes.split(",")
    : grantedScopes ?? [];

  return scopes.some((scope) => typeof scope === "string" && scope.trim() === "read_brand")
    ? "GRANTED"
    : "MISSING";
}
