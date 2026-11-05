import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webhookFixtures } from "../../helpers/shopify-webhook-fixtures";
const output = vi.hoisted(() => ({records: [] as Array<{event: string; data: Record<string, unknown>}>, broken: false}));
const ports = vi.hoisted(() => ({shop: vi.fn(), add: vi.fn(), getJob: vi.fn(), construct: vi.fn(), auth: vi.fn(), emitters: [] as Array<(error: Error) => void>}));
vi.mock("@modainteract/moda-interact-shared/logging", async original => {
  const actual = await original<typeof import("@modainteract/moda-interact-shared/logging")>();
  return {...actual, createLogger: (options: Parameters<typeof actual.createLogger>[0]) => actual.createLogger({...options,
    sink: record => {if (output.broken) throw new Error("sink failed"); output.records.push(JSON.parse(JSON.stringify(record)));}})};
});
vi.mock("../../../app/db.server", () => ({default: {shop: {findUnique: ports.shop}}}));
vi.mock("../../../app/shopify.server", () => ({apiKey: "fixture-app", authenticate: {webhook: ports.auth}}));
vi.mock("bullmq", async () => {
  const {EventEmitter} = await import("node:events");
  return {Queue: class extends EventEmitter {
    constructor(public name: string) {super(); ports.construct(); ports.emitters.push(error => this.emit("error", error));}
    add = ports.add; getJob = ports.getJob; close = async () => {};
  }};
});
import { ingestShopifyWebhook } from "../../../app/services/webhooks/shopify-webhook-ingress.service";
import { recordShopifyLifecycleFailure, recordShopifyWebhookRouteFailure } from "../../../app/services/webhooks/shopify-webhook-observability.server";
import { ShopifyWebhookPublicationError, resetShopifyWebhookQueuesForTests, publishShopifyCheckoutCreatedEvent } from "../../../app/services/webhooks/shopify-webhook-queue.server";
import { action } from "../../../app/routes/webhooks/root/route";
function input(topic = "CHECKOUTS_CREATE", payload: Record<string, unknown> = {token: "checkout-fixture", created_at: "2026-11-01T00:00:00Z"}) {
  return {request: new Request("https://app.test/webhooks", {method: "POST", headers: {"X-Shopify-Webhook-Id": "delivery-fixture"}}),
    appKey: "fixture-app", shop: "shop-a.myshopify.com", topic, payload, apiVersion: "2026-07", eventId: "event-fixture", triggeredAt: "2026-11-01T00:00:00Z"};
}
const sourceFailure = () => Object.assign(new Error("original driver marker redis://user:opaque-redis-secret@redis-private.example rediss://user:opaque-tls-secret@tls-private.example rediss://tls-noauth-private.example:6379 email=private@example.test", {
  cause: new Error("original cause access_token=private-token"),
}), {code: "ECONNREFUSED"});
const records = (event: string) => output.records.filter(record => record.event === event);
function assertEvidence(broken: boolean, event = "shopify.webhook.publication_failed") {
  expect(records(event)).toHaveLength(broken ? 0 : 1);
  if (broken) return;
  const json = JSON.stringify(output.records);
  for (const marker of ["original driver marker", "original cause", "ECONNREFUSED"]) expect(json).toContain(marker);
  for (const secret of ["opaque-redis-secret", "redis-private.example", "opaque-tls-secret", "tls-private.example", "tls-noauth-private.example", "private@example.test", "private-token"]) expect(json).not.toContain(secret);
}
beforeEach(() => {
  vi.clearAllMocks(); output.records.length = 0; output.broken = false; ports.emitters.length = 0;
  vi.stubEnv("REDIS_URL", "redis://fixture.invalid"); ports.add.mockResolvedValue({id: "returned-id"}); ports.getJob.mockResolvedValue(null);
  ports.shop.mockResolvedValue({id: "shop-a", domain: "shop-a.myshopify.com", status: "ACTIVE"});
});
afterEach(async () => {await resetShopifyWebhookQueuesForTests(); vi.unstubAllEnvs();});

describe.each([false, true])("Shared webhook diagnostics, broken sink=%s", broken => {
  beforeEach(() => {output.broken = broken;});
  it("logs the original add failure once and keeps trusted identity and typed 503", async () => {
    const source = sourceFailure(); ports.add.mockImplementationOnce(async () => {ports.emitters[0](source); throw source;});
    expect((await ingestShopifyWebhook(input())).status).toBe(503); assertEvidence(broken);
    expect(records("shopify.webhook.queue_failed")).toHaveLength(0);
    if (!broken) {
      expect(records("shopify.webhook.publication_failed")[0].data).toMatchObject({shopId: "shop-a", stage: "add", origin: "transport", sourceCode: "ECONNREFUSED", reasonCode: "QUEUE_ADD_FAILED"});
      expect(records("shopify.webhook.outcome")[0].data).toMatchObject({shopId: "shop-a", outcome: "QUEUE_ADD_FAILED", queue: "checkout-events"});
    }
    expect(source.cause).toBeInstanceOf(Error); expect(ports.shop).toHaveBeenCalledTimes(1);
    if (!broken) process.stdout.write(`WEBHOOK_PUBLICATION_DIAGNOSTIC ${JSON.stringify(records("shopify.webhook.publication_failed")[0])}\n`);
  });
  it("logs constructor failures without fabricating an external response", async () => {
    ports.construct.mockImplementationOnce(() => {throw sourceFailure();});
    expect((await ingestShopifyWebhook(input())).status).toBe(503); assertEvidence(broken);
    if (!broken) expect(records("shopify.webhook.publication_failed")[0].data).toMatchObject({stage: "queue_acquisition", origin: "internal"});
  });
  it("logs internal missing configuration without inventing a driver cause/code", async () => {
    vi.stubEnv("REDIS_URL", ""); expect((await ingestShopifyWebhook(input())).status).toBe(503);
    if (!broken) {
      expect(records("shopify.webhook.publication_failed")[0].data).toMatchObject({stage: "configuration", origin: "internal", reasonCode: "REDIS_UNAVAILABLE", causeChain: []});
      expect(records("shopify.webhook.publication_failed")[0].data).not.toHaveProperty("sourceCode");
    }
  });
  it("handles idle queue error events without crashing or leaking connection strings", async () => {
    await publishShopifyCheckoutCreatedEvent({event: webhookFixtures()[0].event}); output.records.length = 0;
    ports.emitters[0](sourceFailure()); assertEvidence(broken, "shopify.webhook.queue_failed");
  });
  it("keeps DB error ownership at the generic route and rethrows the same exception", async () => {
    const source = Object.assign(sourceFailure(), {code: "P2010"}); ports.shop.mockRejectedValueOnce(source);
    ports.auth.mockResolvedValueOnce(input()); const args = {request: input().request};
    await expect(action(args)).rejects.toBe(source); expect(ports.add).not.toHaveBeenCalled();
    expect(records("shopify.webhook.failed")).toHaveLength(broken ? 0 : 1);
    if (!broken) expect(records("shopify.webhook.failed")[0].data).toMatchObject({origin: "database", databaseCode: "P2010"});
  });
  it("keeps one 503/final outcome after a deadline even when the add later succeeds", async () => {
    vi.useFakeTimers(); let settle!: () => void;
    ports.add.mockImplementationOnce(() => new Promise<void>(resolve => {settle = resolve;}));
    try {
      const response = ingestShopifyWebhook(input());
      await vi.advanceTimersByTimeAsync(3500); expect((await response).status).toBe(503);
      if (!broken) {
        expect(records("shopify.webhook.publication_failed")[0].data).toMatchObject({stage: "deadline", origin: "internal", reasonCode: "PUBLICATION_TIMEOUT", causeChain: []});
        expect(records("shopify.webhook.publication_failed")[0].data).not.toHaveProperty("sourceCode");
      }
      settle(); await vi.advanceTimersByTimeAsync(0);
      expect(records("shopify.webhook.outcome")).toHaveLength(broken ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
  });

  it("retains an actual connection error observed while readiness/add hangs", async () => {
    vi.useFakeTimers(); const source = sourceFailure(); let settle!: () => void;
    ports.add.mockImplementationOnce(() => {ports.emitters[0](source); return new Promise<void>(resolve => {settle = resolve;});});
    try {
      const response = ingestShopifyWebhook(input()); await vi.advanceTimersByTimeAsync(3500);
      expect((await response).status).toBe(503); assertEvidence(broken);
      if (!broken) expect(records("shopify.webhook.publication_failed")[0].data).toMatchObject({stage: "deadline", origin: "internal", reasonCode: "PUBLICATION_TIMEOUT", sourceCode: "ECONNREFUSED"});
      expect(records("shopify.webhook.queue_failed")).toHaveLength(0); settle(); await vi.advanceTimersByTimeAsync(0);
    } finally {vi.useRealTimers();}
  });

  it("preserves lifecycle caller ownership, source code and cause without a second route diagnostic", () => {
    const source = sourceFailure();
    const wrapper = new ShopifyWebhookPublicationError("safe publication wrapper", "QUEUE_ADD_FAILED", {cause: source, stage: "add", queue: "checkout-events", jobId: "safe-job"});
    recordShopifyLifecycleFailure({operation: "lifecycle_publication", stage: "publication", origin: "best_effort", error: wrapper, shopId: "shop-a"});
    recordShopifyWebhookRouteFailure({request: input().request, route: "/webhooks/lifecycle", error: wrapper, ackMs: 1});
    assertEvidence(broken, "shopify.lifecycle.failed"); expect(records("shopify.webhook.failed")).toHaveLength(0);
    expect(wrapper.cause).toBe(source);
    if (!broken) expect(records("shopify.lifecycle.failed")[0].data).toMatchObject({reasonCode: "QUEUE_ADD_FAILED", sourceCode: "ECONNREFUSED", publicationStage: "add", origin: "transport"});
  });

});

it.each([
  ["CHECKOUTS_CREATE", {token: "checkout-fixture"}], ["CHECKOUTS_UPDATE", {token: "checkout-fixture"}],
  ["CARTS_CREATE", {token: "cart-fixture", line_items: []}], ["CARTS_UPDATE", {token: "cart-fixture", line_items: []}],
  ["ORDERS_CREATE", {admin_graphql_api_id: "gid://shopify/Order/42", created_at: "2026-11-01T00:00:00Z"}],
  ...["discounts/create", "discounts/update", "discounts/delete", "DISCOUNTS_REDEEMCODE_ADDED", "DISCOUNTS_REDEEMCODE_REMOVED"].map(topic => [topic, {}]),
] as Array<[string, Record<string, unknown>]>)("emits one final acceptance for %s with one narrow lookup/add", async (topic, payload) => {
  expect((await ingestShopifyWebhook(input(topic, payload))).status).toBe(200);
  expect(ports.shop).toHaveBeenCalledExactlyOnceWith({where: {domain: "shop-a.myshopify.com"}, select: {id: true, domain: true, status: true}});
  expect(ports.add).toHaveBeenCalledTimes(1); expect(ports.getJob).not.toHaveBeenCalled(); expect(records("shopify.webhook.outcome")).toHaveLength(1);
  expect(records("shopify.webhook.outcome")[0].data.outcome).toBe("QUEUE_ACCEPTED");
});
it.each([null, {id: "shop-a", domain: "shop-a.myshopify.com", status: "SUSPENDED"}])("acknowledges discarded unavailable tenant %s without publication", async shop => {
  ports.shop.mockResolvedValueOnce(shop); expect((await ingestShopifyWebhook(input())).status).toBe(200);
  expect(ports.shop).toHaveBeenCalledTimes(1); expect(ports.add).not.toHaveBeenCalled();
  expect(records("shopify.webhook.outcome")[0].data.outcome).toBe(shop ? "IGNORED_INACTIVE_SHOP" : "IGNORED_UNKNOWN_SHOP");
});
it("ignores unsupported topics only after validating metadata and without looking up Shop", async () => {
  expect((await ingestShopifyWebhook(input("PRODUCTS_CREATE"))).status).toBe(200);
  expect(ports.shop).not.toHaveBeenCalled(); expect(ports.add).not.toHaveBeenCalled();
  const invalid = input("PRODUCTS_CREATE"); invalid.request.headers.delete("X-Shopify-Webhook-Id");
  expect((await ingestShopifyWebhook(invalid)).status).toBe(400); expect(ports.shop).not.toHaveBeenCalled();
});
it("bounds supplied causes to four known entries", async () => {
  let cause: Error = new Error("fifth cause must be absent");
  for (let index = 4; index >= 1; index--) cause = new Error(`safe cause ${index}`, {cause});
  ports.add.mockRejectedValueOnce(Object.assign(new Error("safe root", {cause}), {code: "EPIPE"}));
  expect((await ingestShopifyWebhook(input())).status).toBe(503);
  expect(records("shopify.webhook.publication_failed")[0].data.causeChain).toHaveLength(4);
  expect(JSON.stringify(output.records)).not.toContain("fifth cause must be absent");
});

it("accepts consent once without including the exact customer identifier in observations", async () => {
  const request = input("CUSTOMERS_WHATS_APP_MARKETING_CONSENT_UPDATE", {customer_id: "706405506930370084"});
  const response = await ingestShopifyWebhook({...request, authenticatedConsentRawBody: '{"customer_id":706405506930370084}'});
  expect(response.status).toBe(200); expect(ports.add).toHaveBeenCalledTimes(1); expect(ports.shop).toHaveBeenCalledTimes(1);
  expect(records("shopify.webhook.outcome")).toHaveLength(1);
  expect(records("shopify.webhook.outcome")[0].data.outcome).toBe("QUEUE_ACCEPTED");
  expect(JSON.stringify(output.records)).not.toContain("706405506930370084");
});
