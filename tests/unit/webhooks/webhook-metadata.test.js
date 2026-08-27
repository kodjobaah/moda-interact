import { describe, expect, it } from "vitest";
import {
  parseWebhookMetadata,
  WebhookMetadataError,
} from "../../../app/services/webhooks/webhook-metadata";

function auth(overrides = {}) {
  return {
    appKey: "app-key",
    shop: "shop.myshopify.com",
    topic: "ORDERS_CREATE",
    apiVersion: "2026-07",
    eventId: "evt-1",
    triggeredAt: "2024-01-01T00:00:00Z",
    name: "orders/create",
    ...overrides,
  };
}

describe("parseWebhookMetadata", () => {
  it("extracts metadata from X-Shopify-* headers", () => {
    const headers = new Headers({
      "X-Shopify-Webhook-Id": "delivery-1",
      "X-Shopify-Event-Id": "evt-1",
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Triggered-At": "2024-01-01T00:00:00Z",
      "X-Shopify-Name": "orders/create",
    });

    const metadata = parseWebhookMetadata(headers, auth());

    expect(metadata.appKey).toBe("app-key");
    expect(metadata.deliveryId).toBe("delivery-1");
    expect(metadata.eventId).toBe("evt-1");
    expect(metadata.shopDomain).toBe("shop.myshopify.com");
    expect(metadata.topic).toBe("ORDERS_CREATE");
    expect(metadata.apiVersion).toBe("2026-07");
    expect(metadata.triggeredAt).toBeInstanceOf(Date);
    expect(metadata.triggeredAtRaw).toBe("2024-01-01T00:00:00Z");
    expect(metadata.subscriptionName).toBe("orders/create");
    expect(metadata.receivedAt).toBeInstanceOf(Date);
  });

  it("accepts Webhook-Id as an alias when only it is present", () => {
    const headers = new Headers({ "Webhook-Id": "delivery-alias" });
    const metadata = parseWebhookMetadata(headers, auth());
    expect(metadata.deliveryId).toBe("delivery-alias");
  });

  it("accepts matching primary and alias delivery headers", () => {
    const headers = new Headers({
      "X-Shopify-Webhook-Id": "same-id",
      "Webhook-Id": "same-id",
    });
    const metadata = parseWebhookMetadata(headers, auth());
    expect(metadata.deliveryId).toBe("same-id");
  });

  it("throws MISSING_DELIVERY_ID when no delivery header exists", () => {
    const headers = new Headers();
    expect(() => parseWebhookMetadata(headers, auth())).toThrow(
      WebhookMetadataError,
    );
    try {
      parseWebhookMetadata(headers, auth());
      expect.unreachable();
    } catch (error) {
      expect(error.code).toBe("MISSING_DELIVERY_ID");
    }
  });

  it("throws CONFLICTING_DELIVERY_ID when the headers disagree", () => {
    const headers = new Headers({
      "X-Shopify-Webhook-Id": "delivery-a",
      "Webhook-Id": "delivery-b",
    });
    try {
      parseWebhookMetadata(headers, auth());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookMetadataError);
      expect(error.code).toBe("CONFLICTING_DELIVERY_ID");
    }
  });

  it("never surfaces an HMAC field on parsed metadata", () => {
    const headers = new Headers({
      "X-Shopify-Webhook-Id": "delivery-1",
      "X-Shopify-Hmac-Sha256": "should-never-be-read",
    });
    const metadata = parseWebhookMetadata(headers, auth());
    expect(JSON.stringify(metadata)).not.toContain("should-never-be-read");
  });
});
