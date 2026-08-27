import { describe, expect, it } from "vitest";
import { normalizeCheckoutObservedPayload } from "../../../app/services/webhooks/checkout-normalization";
import { normalizeOrderCompletedPayload } from "../../../app/services/webhooks/order-normalization";

describe("normalizeCheckoutObservedPayload", () => {
  it("returns a stable target payload shape", () => {
    const payload = normalizeCheckoutObservedPayload({
      token: "checkout-token-1",
      cart_token: "cart-token-1",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:05:00Z",
      completed_at: "2024-01-01T00:10:00Z",
      currency: "USD",
      total_price: "19.99",
      abandoned_checkout_url: "https://shop.example/checkout",
      customer: {
        id: 42,
        phone: "+15555550100",
        email: "customer@example.com",
        first_name: "Ada",
        last_name: "Lovelace",
      },
      line_items: [
        {
          product_id: 1,
          variant_id: 2,
          title: "T-Shirt",
          sku: "TS-1",
          quantity: 1,
          price: "19.99",
        },
      ],
    });

    expect(payload).toEqual(
      expect.objectContaining({
        checkoutToken: "checkout-token-1",
        cartToken: "cart-token-1",
        total: {
          amount: "19.99",
          currencyCode: "USD",
        },
        checkoutUrl: "https://shop.example/checkout",
        checkoutCreatedAt: "2024-01-01T00:00:00Z",
        checkoutUpdatedAt: "2024-01-01T00:05:00Z",
        completedAt: "2024-01-01T00:10:00Z",
      }),
    );
    expect(payload.customer).toMatchObject({
      shopifyCustomerId: "42",
      phone: "+15555550100",
      email: "customer@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(payload.lineItems).toHaveLength(1);
  });

  it("returns null when the checkout token is missing", () => {
    expect(normalizeCheckoutObservedPayload({})).toBeNull();
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
      shopifyCustomerId: "gid://shopify/Customer/42",
      total: {
        amount: "19.99",
        currencyCode: "USD",
      },
      completedAt: "2024-01-02T00:00:00Z",
    });
  });

  it("accepts a missing checkout token", () => {
    expect(
      normalizeOrderCompletedPayload({
        admin_graphql_api_id: "gid://shopify/Order/123",
        checkout_token: null,
        created_at: "2024-01-02T00:00:00Z",
      }),
    ).toEqual(
      expect.objectContaining({
        checkoutToken: null,
      }),
    );
  });
});
