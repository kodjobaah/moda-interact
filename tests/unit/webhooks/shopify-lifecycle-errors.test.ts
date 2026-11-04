import { afterEach, describe, expect, it, vi } from "vitest";

const {
  recordShopifyLifecycleFailure,
  recordShopifyWebhookAuthenticationFailure,
  recordShopifyWebhookRouteFailure,
} = await import("../../../app/services/webhooks/shopify-webhook-observability.server");

afterEach(() => vi.restoreAllMocks());

function emittedRecord(spy: { mock: { calls: unknown[][] } }) {
  const line = spy.mock.calls.map((call) => call[0]).find(
    (value: unknown) => typeof value === "string" && value.includes('"shopify.'),
  );
  if (typeof line !== "string") throw new Error("Shared logger did not emit a JSON record");
  return JSON.parse(line);
}

describe("Shopify lifecycle Shared diagnostics", () => {
  it("emits safe SDK exception wording and cause without untrusted request headers", () => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://example.test/webhooks/app/uninstalled", {
      method: "POST",
      headers: { authorization: "Bearer HEADER_TOKEN_SENTINEL", "x-shopify-hmac-sha256": "HMAC_SENTINEL" },
    });
    const failure = new Error("sdk auth exception marker", { cause: new Error("sdk transport cause") });

    recordShopifyWebhookAuthenticationFailure({
      request,
      route: "/webhooks/app/uninstalled",
      error: failure,
      ackMs: 4,
    });

    const record = emittedRecord(output);
    expect(record.event).toBe("shopify.webhook.authentication_failed");
    expect(record.data).toMatchObject({
      classification: "sdk_exception",
      origin: "sdk_exception",
      statusCode: null,
      error: { message: "sdk auth exception marker" },
      causeChain: [{ message: "sdk transport cause" }],
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("HEADER_TOKEN_SENTINEL");
    expect(serialized).not.toContain("HMAC_SENTINEL");
  });

  it("classifies a Shopify 401 Response without serializing its body", () => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("https://example.test/webhooks/app/uninstalled", { method: "POST" });
    const denial = new Response("RESPONSE_BODY_SENTINEL", { status: 401 });

    recordShopifyWebhookAuthenticationFailure({
      request,
      route: "/webhooks/app/uninstalled",
      error: denial,
      ackMs: 3,
    });

    const record = emittedRecord(output);
    expect(record.data).toMatchObject({
      classification: "sdk_denial",
      origin: "sdk_response",
      statusCode: 401,
      errorType: "Response",
    });
    expect(JSON.stringify(record)).not.toContain("RESPONSE_BODY_SENTINEL");
  });

  it("emits safe original wording, database code and bounded causes without secret or PII sentinels", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalCause = Object.assign(new Error(
      "upstream failed for https://db-user:db-password@db.example.test/app?access_token=URL_TOKEN_SENTINEL",
    ), { code: "P2002" });
    const failure = new Error(
      "discount publication failed for EMAIL_SENTINEL@example.test +447700900123 Bearer ACCESS_SENTINEL",
      { cause: originalCause },
    );

    recordShopifyWebhookRouteFailure({
      request: new Request("https://example.test/webhooks/app/uninstalled", { method: "POST" }),
      route: "/webhooks/app/uninstalled",
      topic: "APP_UNINSTALLED",
      shopDomain: "merchant.myshopify.com",
      operation: "mark_uninstalled",
      stage: "transaction",
      origin: "database",
      error: failure,
      ackMs: 8,
    });

    const record = emittedRecord(output);
    const serialized = JSON.stringify(record);
    expect(record.event).toBe("shopify.webhook.failed");
    expect(record.data).toMatchObject({
      operation: "mark_uninstalled",
      stage: "transaction",
      origin: "database",
      databaseCode: "P2002",
      error: { message: expect.stringContaining("discount publication failed") },
      causeChain: [{ message: expect.stringContaining("upstream failed") }],
      redactionApplied: true,
    });
    for (const sentinel of [
      "EMAIL_SENTINEL",
      "447700900123",
      "ACCESS_SENTINEL",
      "URL_TOKEN_SENTINEL",
      "db-password",
    ]) expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain("discount publication failed");
    expect(serialized).toContain("upstream failed");
  });

  it("isolates a throwing Shared logger sink from lifecycle business behavior", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("sink failure");
    });
    expect(() => recordShopifyLifecycleFailure({
      operation: "subscription_activated_discount_sync",
      stage: "publish",
      origin: "best_effort",
      error: new Error("queue unavailable"),
    })).not.toThrow();
  });
});