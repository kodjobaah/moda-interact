import { describe, expect, it } from "vitest";
import {
  ShopifyWebhookMetadataError,
  parseShopifyWebhookMetadata,
} from "../../../app/services/webhooks/shopify-webhook-metadata";

function auth(overrides = {}) {
  return {
    appKey: "app-key",
    shop: "shop.myshopify.com",
    topic: "CHECKOUTS_CREATE",
    apiVersion: "2026-07",
    eventId: "event-1",
    triggeredAt: "2024-01-01T00:00:00Z",
    name: "checkout/create",
    ...overrides,
  };
}

describe("parseShopifyWebhookMetadata", () => {
  it("parses the authenticated metadata and the Shopify delivery id", () => {
    const headers = new Headers({
      "X-Shopify-Webhook-Id": "delivery-1",
      "X-Shopify-API-Version": "2026-08",
      "X-Shopify-Event-Id": "event-2",
      "X-Shopify-Triggered-At": "2024-01-02T00:00:00Z",
      "X-Shopify-Name": "checkout/update",
    });

    const metadata = parseShopifyWebhookMetadata(headers, auth());

    expect(metadata).toMatchObject({
      appKey: "app-key",
      deliveryId: "delivery-1",
      eventId: "event-2",
      shopDomain: "shop.myshopify.com",
      providerTopic: "CHECKOUTS_CREATE",
      apiVersion: "2026-08",
      triggeredAtRaw: "2024-01-02T00:00:00Z",
      subscriptionName: "checkout/update",
    });
    expect(metadata.triggeredAt).toBeInstanceOf(Date);
    expect(metadata.receivedAt).toBeInstanceOf(Date);
  });

  it("throws when the delivery id is missing", () => {
    const headers = new Headers();

    expect(() => parseShopifyWebhookMetadata(headers, auth())).toThrow(
      ShopifyWebhookMetadataError,
    );

    try {
      parseShopifyWebhookMetadata(headers, auth());
    } catch (error) {
      expect(error.code).toBe("MISSING_DELIVERY_ID");
    }
  });

  it("throws when the delivery id headers conflict", () => {
    const headers = new Headers({
      "X-Shopify-Webhook-Id": "delivery-a",
      "Webhook-Id": "delivery-b",
    });

    expect(() => parseShopifyWebhookMetadata(headers, auth())).toThrow(
      ShopifyWebhookMetadataError,
    );

    try {
      parseShopifyWebhookMetadata(headers, auth());
    } catch (error) {
      expect(error.code).toBe("CONFLICTING_DELIVERY_ID");
    }
  });
});
