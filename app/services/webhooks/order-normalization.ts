export type ShopifyOrderCompletedPayload = {
  orderId: string | null;
  checkoutToken: string;
  customerId: string | null;
  totalPrice: string | null;
  currency: string | null;
  completedAt: string | null;
};

export function normalizeOrderCompletedPayload(
  payload: Record<string, unknown>,
): ShopifyOrderCompletedPayload | null {
  const checkoutToken =
    typeof payload.checkout_token === "string" ? payload.checkout_token : null;

  if (!checkoutToken) {
    return null;
  }

  const customer =
    payload.customer &&
    typeof payload.customer === "object" &&
    !Array.isArray(payload.customer)
      ? (payload.customer as Record<string, unknown>)
      : null;

  const orderId =
    typeof payload.admin_graphql_api_id === "string"
      ? payload.admin_graphql_api_id
      : null;

  return {
    orderId,
    checkoutToken,
    customerId:
      typeof customer?.admin_graphql_api_id === "string"
        ? customer.admin_graphql_api_id
        : null,
    totalPrice:
      typeof payload.current_total_price === "string"
        ? payload.current_total_price
        : typeof payload.total_price === "string"
          ? payload.total_price
          : null,
    currency: typeof payload.currency === "string" ? payload.currency : null,
    completedAt:
      typeof payload.created_at === "string" ? payload.created_at : null,
  };
}
