import { describe, expect, it } from "vitest";
import {
  normalizeCheckoutCreatedPayload,
  normalizeCheckoutUpdatedPayload,
} from "../../../app/services/webhooks/checkout-normalization";
import { normalizeOrderCompletedPayload } from "../../../app/services/webhooks/order-normalization";

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
      checkoutCreatedAt: "2024-01-01T00:00:00Z",
    });
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
      completedAt: "2024-01-02T00:00:00Z",
    });
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
