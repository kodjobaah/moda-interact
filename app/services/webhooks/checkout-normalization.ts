import type { ShopifyCheckoutObservedPayload } from "@modainteract/moda-interact-shared/shopify";

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

function toMoneyOrNull(
  amountValue: unknown,
  currencyValue: unknown,
): ShopifyCheckoutObservedPayload["total"] {
  const amount = toStringOrNull(amountValue);
  const currencyCode = toStringOrNull(currencyValue);

  if (!amount || !currencyCode) {
    return null;
  }

  return { amount, currencyCode: currencyCode.toUpperCase() };
}

export function normalizeCheckoutObservedPayload(
  payload: Record<string, unknown>,
): ShopifyCheckoutObservedPayload | null {
  const checkoutToken = toStringOrNull(payload.token);

  if (!checkoutToken) {
    return null;
  }

  const customer = asRecord(payload.customer);
  const customerReference =
    customer ||
    payload.phone ||
    payload.email ||
    payload.sms_marketing_phone ||
    payload.first_name ||
    payload.last_name
      ? {
          shopifyCustomerId:
            customer && customer.id != null ? String(customer.id) : null,
          email: toStringOrNull(payload.email) ?? toStringOrNull(customer?.email),
          phone:
            toStringOrNull(payload.phone) ??
            toStringOrNull(payload.sms_marketing_phone) ??
            toStringOrNull(customer?.phone),
          firstName: toStringOrNull(customer?.first_name),
          lastName: toStringOrNull(customer?.last_name),
        }
      : null;

  return {
    checkoutToken,
    cartToken: toStringOrNull(payload.cart_token),
    checkoutUrl:
      toStringOrNull(payload.abandoned_checkout_url) ??
      toStringOrNull(payload.checkout_url),
    customer: customerReference,
    total: toMoneyOrNull(
      payload.total_price ?? payload.current_total_price,
      payload.presentment_currency ?? payload.currency,
    ),
    lineItems: Array.isArray(payload.line_items)
      ? payload.line_items
          .map(asRecord)
          .filter(
            (item): item is ShopifyCheckoutLineItemPayload => item !== null,
          )
          .map((item) => ({
            lineItemId: item.id != null ? String(item.id) : null,
            productId: item.product_id != null ? String(item.product_id) : null,
            variantId: item.variant_id != null ? String(item.variant_id) : null,
            title:
              toStringOrNull(item.title) ??
              toStringOrNull(item.presentment_title) ??
              "Unknown item",
            variantTitle:
              toStringOrNull(item.variant_title) ??
              toStringOrNull(item.presentment_variant_title),
            sku: toStringOrNull(item.sku),
            quantity: toNumberOrNull(item.quantity) ?? 1,
            unitPrice:
              toStringOrNull(item.price) ??
              toStringOrNull(item.variant_price) ??
              null,
          }))
      : [],
    checkoutCreatedAt: toStringOrNull(payload.created_at),
    checkoutUpdatedAt: toStringOrNull(payload.updated_at),
    completedAt: toStringOrNull(payload.completed_at),
  };
}
