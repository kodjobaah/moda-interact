import { describe, expect, it } from "vitest";
import {
  normalizeCheckoutCreatedPayload,
  normalizeCheckoutUpdatedPayload,
} from "../../../app/services/webhooks/checkout-normalization";
import { normalizeOrderCompletedPayload } from "../../../app/services/webhooks/order-normalization";
import { normalizeCartActivityPayload } from "../../../app/services/webhooks/cart-activity-normalization";
import { normalizeShopifyInternationalContext } from "../../../app/services/webhooks/international-context-normalization";

describe("normalizeShopifyInternationalContext", () => {
  it("preserves language, billing country and presentment currency independently", () => {
    expect(
      normalizeShopifyInternationalContext({
        customer_locale: "en-GB",
        billing_address: { country_code: "GB" },
        shipping_address: { country_code: "FR" },
        presentment_currency: "GBP",
        currency: "USD",
      }),
    ).toEqual({
      languageTag: "en-GB",
      languageSource: "shopify",
      countryCode: "GB",
      currencyCode: "GBP",
      timeZone: null,
    });
  });

  it("keeps valid dimensions when other provider fields are invalid", () => {
    expect(
      normalizeShopifyInternationalContext({
        customer_locale: "not a locale",
        billing_address: { country_code: "DE" },
        shipping_address: { country_code: "FR" },
        presentment_currency: "not-a-currency",
        currency: "USD",
      }),
    ).toEqual({
      languageTag: null,
      languageSource: null,
      countryCode: "DE",
      currencyCode: null,
      timeZone: null,
    });
  });

  it("omits context when authoritative buyer fields are absent", () => {
    expect(
      normalizeShopifyInternationalContext({
        currency: "USD",
        shipping_address: { country_code: "FR" },
      }),
    ).toBeUndefined();
  });
});

describe("normalizeCartActivityPayload", () => {
  it("uses the cart token and proves empty or non-empty state from line_items", () => {
    expect(normalizeCartActivityPayload({ token: "cart-1", line_items: [] })).toEqual({
      cartToken: "cart-1",
      isEmpty: true,
    });
    expect(normalizeCartActivityPayload({ token: "cart-1", line_items: [{ id: 1 }] })).toEqual({
      cartToken: "cart-1",
      isEmpty: false,
    });
  });

  it("leaves emptiness unknown when line_items is unavailable", () => {
    expect(normalizeCartActivityPayload({ token: "cart-1" })).toEqual({
      cartToken: "cart-1",
      isEmpty: null,
    });
  });

  it("rejects a missing or non-string cart token", () => {
    expect(normalizeCartActivityPayload({ line_items: [] })).toBeNull();
    expect(normalizeCartActivityPayload({ token: 123, line_items: [] })).toBeNull();
  });
});

describe("normalizeCheckoutCreatedPayload", () => {
  it("returns a stable target payload shape", () => {
    const payload = normalizeCheckoutCreatedPayload({
      token: "checkout-token-1",
      cart_token: "cart-token-1",
      created_at: "2024-01-01T00:00:00Z",
      abandoned_checkout_url: "https://shop.example/checkout",
    });

    expect(payload).toEqual({
      checkoutToken: "checkout-token-1",
      cartToken: "cart-token-1",
      abandonedCheckoutUrl: "https://shop.example/checkout",
      checkoutCreatedAt: "2024-01-01T00:00:00.000Z",
    });
  });

  it("normalises a provider offset timestamp to canonical UTC ISO", () => {
    const payload = normalizeCheckoutCreatedPayload({
      token: "checkout-token-1",
      cart_token: "cart-token-1",
      created_at: "2021-12-31T19:00:00-05:00",
      abandoned_checkout_url: "https://shop.example/checkout",
    });

    expect(payload).toEqual({
      checkoutToken: "checkout-token-1",
      cartToken: "cart-token-1",
      abandonedCheckoutUrl: "https://shop.example/checkout",
      // -05:00 offset resolves to midnight UTC on 2022-01-01.
      checkoutCreatedAt: "2022-01-01T00:00:00.000Z",
    });
  });

  it("treats an unparseable created_at as null rather than emitting malformed data", () => {
    const payload = normalizeCheckoutCreatedPayload({
      token: "checkout-token-1",
      created_at: "not-a-timestamp",
    });

    expect(payload).not.toBeNull();
    expect(payload.checkoutCreatedAt).toBeNull();
  });

  it("returns null when the checkout token is missing", () => {
    expect(normalizeCheckoutCreatedPayload({})).toBeNull();
  });
});

describe("normalizeCheckoutUpdatedPayload", () => {
  it("returns only the checkout token", () => {
    expect(
      normalizeCheckoutUpdatedPayload({
        token: "checkout-token-1",
        line_items: [{ title: "ignored" }],
      }),
    ).toEqual({
      checkoutToken: "checkout-token-1",
    });
  });

  it("returns null when checkout token is missing", () => {
    expect(normalizeCheckoutUpdatedPayload({})).toBeNull();
  });
});

describe("normalizeOrderCompletedPayload", () => {
  it("returns a stable target payload shape", () => {
    const payload = normalizeOrderCompletedPayload({
      admin_graphql_api_id: "gid://shopify/Order/123",
      checkout_token: "checkout-token-1",
      customer: { admin_graphql_api_id: "gid://shopify/Customer/42" },
      current_total_price: "19.99",
      currency: "USD",
      created_at: "2024-01-02T00:00:00Z",
    });

    expect(payload).toEqual({
      orderId: "gid://shopify/Order/123",
      checkoutToken: "checkout-token-1",
      cartToken: null,
      completedAt: "2024-01-02T00:00:00.000Z",
    });
  });

  it("normalises a provider offset created_at to canonical UTC ISO", () => {
    const payload = normalizeOrderCompletedPayload({
      admin_graphql_api_id: "gid://shopify/Order/820982911946154508",
      checkout_token: "checkout-token-1",
      created_at: "2021-12-31T19:00:00-05:00",
    });

    expect(payload).toEqual({
      orderId: "gid://shopify/Order/820982911946154508",
      checkoutToken: "checkout-token-1",
      cartToken: null,
      completedAt: "2022-01-01T00:00:00.000Z",
    });
  });

  it("falls back to updated_at when created_at is absent and normalises it", () => {
    const payload = normalizeOrderCompletedPayload({
      admin_graphql_api_id: "gid://shopify/Order/123",
      created_at: null,
      updated_at: "2021-12-31T19:00:00-05:00",
    });

    expect(payload).not.toBeNull();
    expect(payload.completedAt).toBe("2022-01-01T00:00:00.000Z");
  });

  it("rejects the order when completedAt is missing or unparseable", () => {
    expect(
      normalizeOrderCompletedPayload({
        admin_graphql_api_id: "gid://shopify/Order/123",
        created_at: null,
        updated_at: null,
      }),
    ).toBeNull();

    expect(
      normalizeOrderCompletedPayload({
        admin_graphql_api_id: "gid://shopify/Order/123",
        created_at: "not-a-timestamp",
      }),
    ).toBeNull();
  });

  it("accepts a missing checkout token", () => {
    expect(
      normalizeOrderCompletedPayload({
        admin_graphql_api_id: "gid://shopify/Order/123",
        checkout_token: null,
        cart_token: "cart-token-1",
        created_at: "2024-01-02T00:00:00Z",
      }),
    ).toEqual(
      expect.objectContaining({
        checkoutToken: null,
        cartToken: "cart-token-1",
      }),
    );
  });
});

