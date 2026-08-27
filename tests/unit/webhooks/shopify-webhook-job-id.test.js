import { describe, expect, it } from "vitest";
import { buildShopifyWebhookJobId } from "../../../app/services/webhooks/shopify-webhook-job-id";

describe("buildShopifyWebhookJobId", () => {
  it("is deterministic for the same appKey/deliveryId pair", () => {
    const first = buildShopifyWebhookJobId("app-key", "delivery-1");
    const second = buildShopifyWebhookJobId("app-key", "delivery-1");

    expect(first).toBe(second);
  });

  it("differs across delivery IDs", () => {
    const first = buildShopifyWebhookJobId("app-key", "delivery-1");
    const second = buildShopifyWebhookJobId("app-key", "delivery-2");

    expect(first).not.toBe(second);
  });

  it("uses the target shopify-<sha256> format", () => {
    const jobId = buildShopifyWebhookJobId("app-key", "delivery-1");

    expect(jobId).toMatch(/^shopify-[0-9a-f]{64}$/);
    expect(jobId).not.toContain(":");
  });
});
