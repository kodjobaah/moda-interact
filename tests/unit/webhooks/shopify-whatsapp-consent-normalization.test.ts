import { describe, expect, it } from "vitest";
import { toShopifyCustomerGid } from "@modainteract/moda-interact-shared/identity";
import {
  normalizeShopifyWhatsAppConsentCustomerId,
  ShopifyWhatsAppConsentPayloadError,
} from "../../../app/services/webhooks/shopify-whatsapp-consent-normalization";

const REAL_SHOPIFY_CUSTOMER_ID = "706405506930370084";

function normalize(raw: string) {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw); }
  catch { payload = { customer_id: 42 }; }
  return normalizeShopifyWhatsAppConsentCustomerId({
    payload,
    authenticatedRawBody: raw,
  });
}

describe("ARCH-045 authenticated customer ID normalization", () => {
  it("preserves numeric 64-bit ID beyond JavaScript precision and matches GraphQL GID", () => {
    const raw = `{"customer_id":${REAL_SHOPIFY_CUSTOMER_ID},"phone_number":"+447700900123"}`;
    const numericId = normalize(raw);
    expect(numericId).toBe(REAL_SHOPIFY_CUSTOMER_ID);
    expect(toShopifyCustomerGid(numericId)).toBe(
      `gid://shopify/Customer/${REAL_SHOPIFY_CUSTOMER_ID}`,
    );
  });

  it("accepts exact canonical GID or a safe numeric ID", () => {
    expect(normalize('{"customer_id":"gid://shopify/Customer/42"}')).toBe("42");
    expect(normalize('{"customer_id":42}')).toBe("42");
  });

  it.each([
    '{"customer_id":42,"customer_id":43}',
    '{"customer":{"customer_id":42}}',
    '{"customer_id":"gid://shopify/Order/42"}',
    '{"customer_id":"gid://shopify/Customer/042"}',
    '{"customer_id":"gid://shopify/Customer/42?shop=other"}',
    '{"customer_id":42,"admin_graphql_api_id":"gid://shopify/Customer/43"}',
    '{"customer_id":42,"id":43}',
    '{"customer_id":9.2}',
    '{"customer_id":9e2}',
    '{"customer_id":null}',
    '{"customer_id":0}',
    '{"customer_id":9223372036854775808}',
    '{"customer_id":"not-a-customer"}',
    '{"customer_id":42} trailing',
  ])("rejects malformed or ambiguous webhook payload: %s", (raw) => {
    expect(() => normalize(raw)).toThrow(ShopifyWhatsAppConsentPayloadError);
  });

  it("rejects no raw authentication evidence, inconsistent parsed payload, or oversized data", () => {
    expect(() => normalizeShopifyWhatsAppConsentCustomerId({
      payload: { customer_id: 43 }, authenticatedRawBody: '{"customer_id":42}',
    })).toThrow(ShopifyWhatsAppConsentPayloadError);
    expect(() => normalizeShopifyWhatsAppConsentCustomerId({
      payload: { customer_id: 42 }, authenticatedRawBody: null,
    })).toThrow(ShopifyWhatsAppConsentPayloadError);
    expect(() => normalizeShopifyWhatsAppConsentCustomerId({
      payload: { customer_id: 42 },
      authenticatedRawBody: JSON.stringify({ customer_id: 42, filler: "x".repeat(70 * 1024) }),
    })).toThrow(ShopifyWhatsAppConsentPayloadError);
  });
});
