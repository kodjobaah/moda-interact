import {
  CheckoutUpdatedPayloadV3Schema,
  type CheckoutCreatedPayloadV2,
  type CheckoutUpdatedPayloadV3,
} from "@modainteract/moda-interact-shared/shopify";
import { isShopifyConsentMarker } from "../shopify-consent/marker";
import { normalizeTimestamp } from "./webhook-normalization-utils";

const CART_CORRELATION_ATTRIBUTE = "moda_cart_correlation_v1";

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeCartCorrelationMarker(
  payload: Record<string, unknown>,
): {
  cartCorrelationMarker?: string;
  cartCorrelationMarkerStatus?: "PRESENT" | "ABSENT" | "INVALID" | "AMBIGUOUS";
} {
  if (!Object.hasOwn(payload, "note_attributes")) return {};
  const attributes = payload.note_attributes;
  if (Array.isArray(attributes)) {
    const matches = attributes.filter(attribute =>
      typeof attribute === "object" &&
      attribute !== null &&
      "name" in attribute &&
      attribute.name === CART_CORRELATION_ATTRIBUTE,
    );
    if (matches.length > 1) return { cartCorrelationMarkerStatus: "AMBIGUOUS" };
    if (matches.length === 0) return { cartCorrelationMarkerStatus: "ABSENT" };
    const match = matches[0];
    const marker = typeof match === "object" && match !== null && "value" in match
      ? match.value
      : undefined;
    return isShopifyConsentMarker(marker)
      ? { cartCorrelationMarker: marker, cartCorrelationMarkerStatus: "PRESENT" }
      : { cartCorrelationMarkerStatus: "INVALID" };
  }
  if (typeof attributes !== "object" || attributes === null) {
    return { cartCorrelationMarkerStatus: "INVALID" };
  }
  const marker = Object.getOwnPropertyDescriptor(attributes, CART_CORRELATION_ATTRIBUTE)?.value;
  if (marker === undefined) return { cartCorrelationMarkerStatus: "ABSENT" };
  return isShopifyConsentMarker(marker)
    ? { cartCorrelationMarker: marker, cartCorrelationMarkerStatus: "PRESENT" }
    : { cartCorrelationMarkerStatus: "INVALID" };
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
    ...normalizeCartCorrelationMarker(payload),
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
  const cartMarker = normalizeCartCorrelationMarker(payload);
  if (cartMarker.cartCorrelationMarkerStatus) {
    normalized.cartCorrelationMarkerStatus = cartMarker.cartCorrelationMarkerStatus;
  }
  if (cartMarker.cartCorrelationMarker) {
    normalized.cartCorrelationMarker = cartMarker.cartCorrelationMarker;
  }

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

