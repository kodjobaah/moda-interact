export type ShopifyCheckoutObservedPayload = {
  checkoutToken: string;
  cartToken: string | null;
  currency: string | null;
  totalPrice: string | null;
  checkoutUrl: string | null;
  customer: {
    shopifyCustomerId: string | null;
    phone: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  lineItems: Array<{
    productId: string | null;
    variantId: string | null;
    title: string | null;
    variantTitle: string | null;
    sku: string | null;
    quantity: number | null;
    price: string | null;
  }>;
  detectedAt: string;
  completedAt: string | null;
};

type ShopifyCheckoutLineItemPayload = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function normalizeCheckoutObservedPayload(
  payload: Record<string, unknown>,
): ShopifyCheckoutObservedPayload | null {
  const checkoutToken = toStringOrNull(payload.token);

  if (!checkoutToken) {
    return null;
  }

  const customer = asRecord(payload.customer);

  return {
    checkoutToken,
    cartToken: toStringOrNull(payload.cart_token),
    currency:
      toStringOrNull(payload.presentment_currency) ??
      toStringOrNull(payload.currency),
    totalPrice: toStringOrNull(payload.total_price),
    checkoutUrl: toStringOrNull(payload.abandoned_checkout_url),
    customer: {
      shopifyCustomerId:
        customer && customer.id != null ? String(customer.id) : null,
      phone:
        toStringOrNull(payload.phone) ??
        toStringOrNull(payload.sms_marketing_phone) ??
        toStringOrNull(customer?.phone),
      email: toStringOrNull(payload.email) ?? toStringOrNull(customer?.email),
      firstName: toStringOrNull(customer?.first_name),
      lastName: toStringOrNull(customer?.last_name),
    },
    lineItems: Array.isArray(payload.line_items)
      ? payload.line_items
          .map(asRecord)
          .filter(
            (item): item is ShopifyCheckoutLineItemPayload => item !== null,
          )
          .map((item) => ({
            productId: item.product_id != null ? String(item.product_id) : null,
            variantId: item.variant_id != null ? String(item.variant_id) : null,
            title: toStringOrNull(item.title) ?? toStringOrNull(item.presentment_title),
            variantTitle:
              toStringOrNull(item.variant_title) ??
              toStringOrNull(item.presentment_variant_title),
            sku: toStringOrNull(item.sku),
            quantity: toNumberOrNull(item.quantity),
            price: toStringOrNull(item.price) ?? toStringOrNull(item.variant_price),
          }))
      : [],
    detectedAt:
      toStringOrNull(payload.created_at) ?? new Date().toISOString(),
    completedAt: toStringOrNull(payload.completed_at),
  };
}
