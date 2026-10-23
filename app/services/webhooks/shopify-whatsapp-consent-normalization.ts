import {
  parseShopifyCustomerIdentity,
} from "@modainteract/moda-interact-shared/identity";

const MAX_CONSENT_WEBHOOK_BYTES = 64 * 1024;

export class ShopifyWhatsAppConsentPayloadError extends Error {
  constructor() {
    super("Invalid Shopify WhatsApp consent webhook customer identity");
    this.name = "ShopifyWhatsAppConsentPayloadError";
  }
}

/**
 * Shopify sends `customer_id` as a JSON number. Real Shopify IDs can exceed
 * Number.MAX_SAFE_INTEGER, so the SDK's already-parsed number is not safe to
 * convert back to a string. Read only that top-level token from the raw body
 * retained BEFORE the authenticated SDK consumes the request.
 *
 * The SDK must have authenticated the very same request before this is called.
 * Do not log or publish the raw payload: it can contain a phone number.
 */
export function normalizeShopifyWhatsAppConsentCustomerId(input: {
  payload: Record<string, unknown>;
  authenticatedRawBody: string | null;
}): string {
  const raw = input.authenticatedRawBody;
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_CONSENT_WEBHOOK_BYTES) {
    throw new ShopifyWhatsAppConsentPayloadError();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ShopifyWhatsAppConsentPayloadError();
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ShopifyWhatsAppConsentPayloadError();
  }

  // Reject a missing or duplicated top-level key. A nested `customer_id` is
  // not a substitute for Shopify's top-level consent webhook principal.
  const rawId = readTopLevelCustomerIdToken(raw);
  if (rawId === null || !("customer_id" in input.payload)) {
    throw new ShopifyWhatsAppConsentPayloadError();
  }

  try {
    const customer = parseShopifyCustomerIdentity(rawId);
    const sdkValue = input.payload.customer_id;

    // A numeric SDK payload is allowed to be rounded by JSON.parse, but it
    // must still represent the same raw integer at JavaScript precision.
    // The authenticated raw decimal remains the source of the exact ID.
    if (typeof sdkValue === "number") {
      if (!Number.isInteger(sdkValue) || Number(customer.numericId) !== sdkValue) {
        throw new ShopifyWhatsAppConsentPayloadError();
      }
    } else if (parseShopifyCustomerIdentity(sdkValue).numericId !== customer.numericId) {
      throw new ShopifyWhatsAppConsentPayloadError();
    }

    // Optional alternate identities must agree with `customer_id`, not silently
    // override it. A GID for an Order or another customer is never accepted.
    for (const alias of ["id", "admin_graphql_api_id"] as const) {
      if (alias in input.payload &&
          parseShopifyCustomerIdentity(input.payload[alias]).numericId !== customer.numericId) {
        throw new ShopifyWhatsAppConsentPayloadError();
      }
    }

    return customer.numericId;
  } catch {
    throw new ShopifyWhatsAppConsentPayloadError();
  }
}

/**
 * Locate exactly one top-level JSON key without coercing its numeric token.
 * JSON.parse above validates the whole JSON grammar; this scanner only keeps
 * integer-token precision (and detects duplicate principals).
 */
function readTopLevelCustomerIdToken(raw: string): string | null {
  let objectDepth = 0;
  let arrayDepth = 0;
  let found: string | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      const start = i;
      i += 1;
      while (i < raw.length) {
        if (raw[i] === "\\") {
          i += 2;
        } else if (raw[i] === '"') {
          break;
        } else {
          i += 1;
        }
      }
      if (i >= raw.length) throw new ShopifyWhatsAppConsentPayloadError();

      if (objectDepth === 1 && arrayDepth === 0) {
        let afterKey = i + 1;
        while (/\s/.test(raw[afterKey] ?? "")) afterKey += 1;
        if (raw[afterKey] === ":" && JSON.parse(raw.slice(start, i + 1)) === "customer_id") {
          if (found !== null) throw new ShopifyWhatsAppConsentPayloadError();
          let valueStart = afterKey + 1;
          while (/\s/.test(raw[valueStart] ?? "")) valueStart += 1;

          if (raw[valueStart] === '"') {
            let end = valueStart + 1;
            while (end < raw.length) {
              if (raw[end] === "\\") end += 2;
              else if (raw[end] === '"') break;
              else end += 1;
            }
            if (end >= raw.length) throw new ShopifyWhatsAppConsentPayloadError();
            found = JSON.parse(raw.slice(valueStart, end + 1));
          } else {
            const match = /^-?[0-9]+/.exec(raw.slice(valueStart));
            if (!match) throw new ShopifyWhatsAppConsentPayloadError();
            const next = raw[valueStart + match[0].length];
            if (next !== "," && next !== "}" && !/\s/.test(next ?? "")) {
              throw new ShopifyWhatsAppConsentPayloadError();
            }
            found = match[0];
          }
        }
      }
      continue;
    }
    if (char === "{") objectDepth += 1;
    else if (char === "}") objectDepth -= 1;
    else if (char === "[") arrayDepth += 1;
    else if (char === "]") arrayDepth -= 1;
  }

  return found;
}
