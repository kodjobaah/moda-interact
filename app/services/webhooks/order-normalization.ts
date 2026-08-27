import type { ShopifyOrderCompletedPayload } from "@modainteract/moda-interact-shared/shopify";

export function normalizeOrderCompletedPayload(
  payload: Record<string, unknown>,
): ShopifyOrderCompletedPayload | null {
  const customer =
    payload.customer &&
    typeof payload.customer === "object" &&
    !Array.isArray(payload.customer)
      ? (payload.customer as Record<string, unknown>)
      : null;

  const orderId =
    typeof payload.admin_graphql_api_id === "string"
      ? payload.admin_graphql_api_id
      : typeof payload.id === "string"
        ? payload.id
        : null;

  const completedAt =
    typeof payload.created_at === "string"
      ? payload.created_at
      : typeof payload.updated_at === "string"
        ? payload.updated_at
        : null;

  if (!orderId || !completedAt) {
    return null;
  }

  return {
    orderId,
    checkoutToken:
      typeof payload.checkout_token === "string"
        ? payload.checkout_token
        : null,
    shopifyCustomerId:
      typeof customer?.admin_graphql_api_id === "string"
        ? customer.admin_graphql_api_id
        : null,
    total:
      typeof payload.current_total_price === "string" &&
      typeof payload.currency === "string"
        ? {
            amount: payload.current_total_price,
            currencyCode: payload.currency.toUpperCase(),
          }
        : typeof payload.total_price === "string" &&
            typeof payload.currency === "string"
          ? {
              amount: payload.total_price,
              currencyCode: payload.currency.toUpperCase(),
            }
          : null,
    completedAt,
  };
}
