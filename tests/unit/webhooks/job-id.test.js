import { describe, expect, it } from "vitest";
import { buildWebhookJobId } from "../../../app/services/webhooks/job-id";

describe("buildWebhookJobId", () => {
  it("is deterministic for the same appKey/deliveryId pair", () => {
    const first = buildWebhookJobId("app-key", "delivery-1");
    const second = buildWebhookJobId("app-key", "delivery-1");
    expect(first).toBe(second);
  });

  it("differs across delivery IDs", () => {
    const first = buildWebhookJobId("app-key", "delivery-1");
    const second = buildWebhookJobId("app-key", "delivery-2");
    expect(first).not.toBe(second);
  });

  it("contains no colons and no timestamp", () => {
    const jobId = buildWebhookJobId("app-key", "delivery-1");
    expect(jobId).not.toContain(":");
    expect(jobId).toMatch(/^shopify-[0-9a-f]{64}$/);
  });
});
