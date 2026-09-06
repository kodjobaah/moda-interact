import type { ShopifyCartActivityPayloadV2 } from "@modainteract/moda-interact-shared/shopify";

export function normalizeCartActivityPayload(
  payload: Record<string, unknown>,
): ShopifyCartActivityPayloadV2 | null {
  const cartToken = typeof payload.token === "string" ? payload.token : null;

  if (!cartToken) {
    return null;
  }

  const lineItems = payload.line_items;
  const isEmpty = Array.isArray(lineItems) ? lineItems.length === 0 : null;

  return { cartToken, isEmpty };
}