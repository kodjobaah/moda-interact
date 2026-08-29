import type {
  CheckoutCreatedPayloadV2,
  CheckoutUpdatedPayloadV2,
} from "@modainteract/moda-interact-shared/shopify";
import { normalizeTimestamp } from "./webhook-normalization-utils";

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeCheckoutCreatedPayload(
  payload: Record<string, unknown>,
): CheckoutCreatedPayloadV2 | null {
  const checkoutToken = toStringOrNull(payload.token);

  if (!checkoutToken) {
    return null;
  }

  return {
    checkoutToken,
    cartToken: toStringOrNull(payload.cart_token),
    abandonedCheckoutUrl: toStringOrNull(payload.abandoned_checkout_url),
    checkoutCreatedAt: normalizeTimestamp(payload.created_at),
  };
}

export function normalizeCheckoutUpdatedPayload(
  payload: Record<string, unknown>,
): CheckoutUpdatedPayloadV2 | null {
  const checkoutToken = toStringOrNull(payload.token);

  if (!checkoutToken) {
    return null;
  }

  return {
    checkoutToken,
  };
}

