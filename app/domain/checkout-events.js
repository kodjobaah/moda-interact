export function normaliseCheckoutCreated(shop, payload) {
  return {
    shop,

    checkoutToken: payload.token,
    cartToken: payload.cart_token ?? null,

    detectedAt: payload.created_at
      ? new Date(payload.created_at).toISOString()
      : new Date().toISOString(),

    currency:
      payload.presentment_currency ??
      payload.currency ??
      null,

    totalPrice: payload.total_price ?? null,

    checkoutUrl:
      payload.abandoned_checkout_url ?? null,

    completedAt:
      payload.completed_at ?? null,

    customer: {
      shopifyCustomerId:
        payload.customer?.id != null
          ? String(payload.customer.id)
          : null,

      phone:
        payload.phone ??
        payload.sms_marketing_phone ??
        payload.customer?.phone ??
        null,

      email:
        payload.email ??
        payload.customer?.email ??
        null,

      firstName:
        payload.customer?.first_name ?? null,

      lastName:
        payload.customer?.last_name ?? null,
    },

    lineItems: Array.isArray(payload.line_items)
      ? payload.line_items.map((item) => ({
          productId:
            item.product_id != null
              ? String(item.product_id)
              : null,

          variantId:
            item.variant_id != null
              ? String(item.variant_id)
              : null,

          title:
            item.title ??
            item.presentment_title ??
            null,

          variantTitle:
            item.variant_title ??
            item.presentment_variant_title ??
            null,

          sku: item.sku ?? null,

          quantity: item.quantity,

          price:
            item.price ??
            item.variant_price ??
            null,
        }))
      : [],
  };
}