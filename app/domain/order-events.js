/**
 * Pure adapter mapping a Shopify ORDERS_CREATE payload onto the exact shape
 * consumed by moda-interact-background's "order-completed" worker. Do not
 * change this shape without coordinating with that repository.
 *
 * @param {string} shop
 * @param {Record<string, any>} payload
 */
export function normaliseOrderCreated(shop, payload) {
  return {
    shop,

    orderId: payload.admin_graphql_api_id ?? null,

    checkoutToken: payload.checkout_token ?? null,

    customerId: payload.customer?.admin_graphql_api_id ?? null,

    totalPrice:
      payload.current_total_price ??
      payload.total_price ??
      null,

    currency: payload.currency ?? null,
  };
}
