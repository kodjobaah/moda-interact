import type { OrderCompletedPayloadV2 } from "@modainteract/moda-interact-shared/shopify";
import { normalizeTimestamp } from "./webhook-normalization-utils";

export function normalizeOrderCompletedPayload(
  payload: Record<string, unknown>,
): OrderCompletedPayloadV2 | null {

  const orderId =
    typeof payload.admin_graphql_api_id === "string" &&
    payload.admin_graphql_api_id.length > 0
      ? payload.admin_graphql_api_id
      : null;

  // Prefer updated_at when created_at is absent; either way the provider
  // timestamp is normalised to canonical UTC ISO so the shared v2 contract is
  // satisfied. completedAt is required, so an unparseable timestamp rejects
  // the order payload rather than emitting a malformed event.
  const completedAt =
    normalizeTimestamp(payload.created_at) ??
    normalizeTimestamp(payload.updated_at);

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
