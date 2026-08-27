import { describe, expect, it } from "vitest";
import { normaliseCheckoutCreated } from "../../../app/domain/checkout-events";
import { normaliseOrderCreated } from "../../../app/domain/order-events";

describe("normaliseCheckoutCreated", () => {
  it("matches the payload shape consumed by the checkout-events worker", () => {
    const payload = {
      token: "checkout-token-1",
      cart_token: "cart-token-1",
      created_at: "2024-01-01T00:00:00Z",
      currency: "USD",
      total_price: "19.99",
      abandoned_checkout_url: "https://shop.example/checkout",
      completed_at: null,
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
    };

    const checkout = normaliseCheckoutCreated("shop.myshopify.com", payload);

    expect(checkout.shop).toBe("shop.myshopify.com");
    expect(checkout.checkoutToken).toBe("checkout-token-1");
    expect(checkout.cartToken).toBe("cart-token-1");
    expect(checkout.customer.shopifyCustomerId).toBe("42");
    expect(checkout.customer.email).toBe("customer@example.com");
    expect(checkout.lineItems).toHaveLength(1);
    expect(checkout.lineItems[0]).toMatchObject({
      productId: "1",
      variantId: "2",
      quantity: 1,
      price: "19.99",
    });
  });
});

describe("normaliseOrderCreated", () => {
  it("matches the existing order-events worker payload shape", () => {
    const payload = {
      admin_graphql_api_id: "gid://shopify/Order/123",
      checkout_token: "checkout-token-1",
      customer: { admin_graphql_api_id: "gid://shopify/Customer/42" },
      current_total_price: "19.99",
      currency: "USD",
    };

    const order = normaliseOrderCreated("shop.myshopify.com", payload);

    expect(order).toEqual({
      shop: "shop.myshopify.com",
      orderId: "gid://shopify/Order/123",
      checkoutToken: "checkout-token-1",
      customerId: "gid://shopify/Customer/42",
      totalPrice: "19.99",
      currency: "USD",
    });
  });

  it("falls back to total_price when current_total_price is absent", () => {
    const order = normaliseOrderCreated("shop.myshopify.com", {
      admin_graphql_api_id: "gid://shopify/Order/999",
      total_price: "5.00",
    });
    expect(order.totalPrice).toBe("5.00");
    expect(order.customerId).toBeNull();
  });

  it("reports a null orderId for an invalid payload instead of throwing", () => {
    const order = normaliseOrderCreated("shop.myshopify.com", {});
    expect(order.orderId).toBeNull();
  });
});
