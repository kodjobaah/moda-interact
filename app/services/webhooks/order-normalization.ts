import type { OrderCompletedPayloadV2 } from "@modainteract/moda-interact-shared/shopify";

export function normalizeOrderCompletedPayload(
  payload: Record<string, unknown>,
): OrderCompletedPayloadV2 | null {

  const orderId =
    typeof payload.admin_graphql_api_id === "string" &&
    payload.admin_graphql_api_id.length > 0
      ? payload.admin_graphql_api_id
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
    cartToken:
      typeof payload.cart_token === "string"
        ? payload.cart_token
        : null,
    completedAt,
  };
}
