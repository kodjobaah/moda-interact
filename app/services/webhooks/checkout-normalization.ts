import {
  CheckoutUpdatedPayloadV3Schema,
  type CheckoutCreatedPayloadV2,
  type CheckoutUpdatedPayloadV3,
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
): CheckoutUpdatedPayloadV3 | null {
  const checkoutToken = toStringOrNull(payload.token);

  if (!checkoutToken) {
    return null;
  }

  // Keep the verified webhook token as the sole checkout identity. The lookup
  // hints are optional: bad or missing hints must not discard a valid update.
  // Validate each hint independently against the published Shared v3 bounds.
  const normalized: CheckoutUpdatedPayloadV3 = { checkoutToken };

  if (Object.hasOwn(payload, "cart_token")) {
    const cartToken = CheckoutUpdatedPayloadV3Schema.shape.cartToken.safeParse(
      payload.cart_token,
    );
    if (cartToken.success) {
      normalized.cartToken = cartToken.data;
    }
  }

  if (Object.hasOwn(payload, "created_at")) {
    const createdAt = payload.created_at === null
      ? null
      : normalizeTimestamp(payload.created_at);
    if (createdAt !== null || payload.created_at === null) {
      const checkoutCreatedAt =
        CheckoutUpdatedPayloadV3Schema.shape.checkoutCreatedAt.safeParse(createdAt);
      if (checkoutCreatedAt.success) {
        normalized.checkoutCreatedAt = checkoutCreatedAt.data;
      }
    }
  }

  if (Object.hasOwn(payload, "abandoned_checkout_url")) {
    const abandonedCheckoutUrl =
      CheckoutUpdatedPayloadV3Schema.shape.abandonedCheckoutUrl.safeParse(
        payload.abandoned_checkout_url,
      );
    if (abandonedCheckoutUrl.success) {
      normalized.abandonedCheckoutUrl = abandonedCheckoutUrl.data;
    }
  }

  return normalized;
}

