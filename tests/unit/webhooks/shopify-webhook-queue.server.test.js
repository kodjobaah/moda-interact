import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseShopifyRecoveryEventV2,
} from "@modainteract/moda-interact-shared/shopify";
import {
  createShopifyWebhookJobId,
  createShopifyOrderJobId,
} from "@modainteract/moda-interact-shared/shopify/node";

const bullMQTelemetry = { tracer: "shared-bullmq-telemetry" };

vi.mock(
  "@modainteract/moda-interact-shared/observability/bullmq",
  () => ({
    createBullMQTelemetry: vi.fn(() => bullMQTelemetry),
  }),
);

class FakeJob {
  constructor(data, state = "delayed") {
    this.data = data;
    this.state = state;
    this.updatedData = null;
    this.delayChanges = [];
  }

  async getState() {
    return this.state;
  }

  async updateData(data) {
    this.updatedData = data;
  }

  async changeDelay(delay) {
    this.delayChanges.push(delay);
  }
}

class FakeQueue {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.jobs = new Map();
    this.addCalls = [];
  }

  async getJob(jobId) {
    return this.jobs.get(jobId) ?? null;
  }

  async add(jobName, data, opts) {
    this.addCalls.push({ jobName, data, opts });
    const job = new FakeJob(data, opts.delay ? "delayed" : "waiting");
    this.jobs.set(opts.jobId, job);
    return job;
  }
}

const queues = {
  checkout: new FakeQueue("checkout-events"),
  order: new FakeQueue("order-events"),
};

const bullmqMock = {
  Queue: class {
    constructor(name, options) {
      const queue = new FakeQueue(name, options);
      if (name === "checkout-events") {
        queues.checkout = queue;
      } else {
        queues.order = queue;
      }
      return queue;
    }
  },
};

vi.mock("bullmq", () => bullmqMock);

const queueModule = await import("../../../app/services/webhooks/shopify-webhook-queue.server");

function resetQueues() {
  queues.checkout = new FakeQueue("checkout-events");
  queues.order = new FakeQueue("order-events");
  process.env.REDIS_URL = "redis://example";
}

beforeEach(async () => {
  resetQueues();
  await queueModule.resetShopifyWebhookQueuesForTests();
});

describe("shopify webhook queue helpers", () => {
  it("creates deterministic delivery and order job ids", () => {
    const checkoutId = createShopifyWebhookJobId("shop_1", "delivery_1");
    const orderId = createShopifyOrderJobId("shop_1", "gid://shopify/Order/1");

    expect(checkoutId).toMatch(/^shopify-/);
    expect(orderId).toMatch(/^order-created-/);
    expect(checkoutId).not.toContain(":");
    expect(orderId).not.toContain(":");
  });

  it("formats tenant-readable job ids without changing the legacy suffix", () => {
    expect(queueModule.createTenantReadableJobId("shop_1", "shopify-abc")).toBe(
      "shop_1--shopify-abc",
    );
    expect(queueModule.createTenantReadableJobId("shop_1", "order-created-abc")).toBe(
      "shop_1--order-created-abc",
    );
    expect(queueModule.createTenantReadableJobId("shop_1", "shopify-abc")).not.toContain(":");
  });

  it("publishes checkout-created work immediately and deduplicates duplicate delivery", async () => {
    const baseEvent = {
      schemaVersion: 2,
      receiptId: "r1",
      deliveryId: "d1",
      eventId: "e1",
      source: "shopify",
      providerTopic: "CHECKOUTS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      receivedAt: "2026-08-28T00:00:01.000Z",
      traceId: "r1",
      orderingKey: "shop_1:checkout_1",
      eventType: "checkout.created",
      payload: {
        checkoutToken: "checkout_1",
        cartToken: "cart_1",
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: "2026-08-28T00:00:00Z",
      },
    };

    const first = await queueModule.publishShopifyCheckoutCreatedEvent({
      event: parseShopifyRecoveryEventV2(baseEvent),
    });

    const second = await queueModule.publishShopifyCheckoutCreatedEvent({
      event: parseShopifyRecoveryEventV2(baseEvent),
    });

    const legacyJobId = createShopifyWebhookJobId("shop_1", "d1");
    const jobId = queueModule.createTenantReadableJobId("shop_1", legacyJobId);
    expect(first.outcome).toBe("enqueued");
    expect(first.jobId).toBe(jobId);
    expect(second.outcome).toBe("duplicate");
    expect(second.jobId).toBe(jobId);
    expect(queues.checkout.addCalls).toHaveLength(1);
    expect(queues.checkout.addCalls[0].opts.jobId).toBe(jobId);
    expect(queues.checkout.addCalls[0].opts.delay).toBeUndefined();
    expect(queues.checkout.addCalls[0].data).toEqual(expect.objectContaining({
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
    }));
  });

  it("publishes checkout update work as a distinct job contract", async () => {
    const updateEvent = {
      schemaVersion: 2,
      receiptId: "r-up-1",
      deliveryId: "delivery-up-1",
      eventId: "e-up-1",
      source: "shopify",
      providerTopic: "CHECKOUTS_UPDATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:20:00.000Z",
      receivedAt: "2026-08-28T00:20:01.000Z",
      traceId: "r-up-1",
      orderingKey: "shop_1:checkout_1",
      eventType: "checkout.updated",
      payload: {
        checkoutToken: "checkout_1",
      },
    };

    const first = await queueModule.publishShopifyCheckoutUpdatedEvent({
      event: parseShopifyRecoveryEventV2(updateEvent),
    });

    const second = await queueModule.publishShopifyCheckoutUpdatedEvent({
      event: parseShopifyRecoveryEventV2(updateEvent),
    });

    expect(first.outcome).toBe("enqueued");
    expect(second.outcome).toBe("duplicate");
    expect(queues.checkout.addCalls).toHaveLength(1);
    expect(queues.checkout.addCalls[0].jobName).toBe("checkout-updated");
    const legacyJobId = createShopifyWebhookJobId("shop_1", "delivery-up-1");
    expect(first.jobId).toBe(queueModule.createTenantReadableJobId("shop_1", legacyJobId));
    expect(first.jobId).toMatch(/^shop_1--/);
  });

  it("keeps order publication immediate and suppresses duplicate order work", async () => {
    const orderEvent = {
      schemaVersion: 2,
      receiptId: "r1",
      deliveryId: "d1",
      eventId: "e1",
      source: "shopify",
      providerTopic: "ORDERS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      receivedAt: "2026-08-28T00:00:01.000Z",
      traceId: "r1",
      orderingKey: "shop_1:gid://shopify/Order/1",
      eventType: "order.completed",
      payload: {
        orderId: "gid://shopify/Order/1",
        checkoutToken: null,
        cartToken: null,
        completedAt: "2026-08-28T00:00:00Z",
      },
    };

    const first = await queueModule.publishShopifyOrderCompletedEvent({
      event: parseShopifyRecoveryEventV2(orderEvent),
    });

    const second = await queueModule.publishShopifyOrderCompletedEvent({
      event: parseShopifyRecoveryEventV2(orderEvent),
    });

    expect(first.outcome).toBe("enqueued");
    expect(second.outcome).toBe("duplicate");
    expect(queues.order.addCalls).toHaveLength(1);
    const legacyJobId = createShopifyOrderJobId("shop_1", "gid://shopify/Order/1");
    expect(first.jobId).toBe(queueModule.createTenantReadableJobId("shop_1", legacyJobId));
    expect(first.jobId).toMatch(/^shop_1--/);
  });

  it("suppresses checkout publication when only the legacy id exists", async () => {
    const event = parseShopifyRecoveryEventV2({
      schemaVersion: 2,
      receiptId: "r-legacy-checkout",
      deliveryId: "d-legacy-checkout",
      eventId: "e-legacy-checkout",
      source: "shopify",
      providerTopic: "CHECKOUTS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      receivedAt: "2026-08-28T00:00:01.000Z",
      traceId: "r-legacy-checkout",
      orderingKey: "shop_1:checkout_legacy",
      eventType: "checkout.created",
      payload: {
        checkoutToken: "checkout_legacy",
        cartToken: null,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: "2026-08-28T00:00:00Z",
      },
    });
    const first = await queueModule.publishShopifyCheckoutCreatedEvent({ event });
    const legacyJobId = createShopifyWebhookJobId("shop_1", event.deliveryId);
    const newJobId = queueModule.createTenantReadableJobId("shop_1", legacyJobId);
    queues.checkout.jobs.delete(newJobId);
    queues.checkout.jobs.set(legacyJobId, new FakeJob(event));

    const second = await queueModule.publishShopifyCheckoutCreatedEvent({ event });

    expect(first.outcome).toBe("enqueued");
    expect(second).toEqual({
      queue: "checkout-events",
      jobId: legacyJobId,
      outcome: "duplicate",
    });
    expect(queues.checkout.addCalls).toHaveLength(1);
  });

  it("suppresses order publication when only the legacy id exists", async () => {
    const event = parseShopifyRecoveryEventV2({
      schemaVersion: 2,
      receiptId: "r-legacy-order",
      deliveryId: "d-legacy-order",
      eventId: "e-legacy-order",
      source: "shopify",
      providerTopic: "ORDERS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      receivedAt: "2026-08-28T00:00:01.000Z",
      traceId: "r-legacy-order",
      orderingKey: "shop_1:gid://shopify/Order/legacy",
      eventType: "order.completed",
      payload: {
        orderId: "gid://shopify/Order/legacy",
        checkoutToken: null,
        cartToken: null,
        completedAt: "2026-08-28T00:00:00Z",
      },
    });
    const first = await queueModule.publishShopifyOrderCompletedEvent({ event });
    const legacyJobId = createShopifyOrderJobId("shop_1", event.payload.orderId);
    const newJobId = queueModule.createTenantReadableJobId("shop_1", legacyJobId);
    queues.order.jobs.delete(newJobId);
    queues.order.jobs.set(legacyJobId, new FakeJob(event));

    const second = await queueModule.publishShopifyOrderCompletedEvent({ event });

    expect(first.outcome).toBe("enqueued");
    expect(second).toEqual({
      queue: "order-events",
      jobId: legacyJobId,
      outcome: "duplicate",
    });
    expect(queues.order.addCalls).toHaveLength(1);
  });

  it("configures bounded retries and retains failed jobs", async () => {
    const checkoutEvent = {
      schemaVersion: 2,
      receiptId: "r-bounded-1",
      deliveryId: "d-bounded-1",
      eventId: "e-bounded-1",
      source: "shopify",
      providerTopic: "CHECKOUTS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T01:00:00.000Z",
      receivedAt: "2026-08-28T01:00:01.000Z",
      traceId: "r-bounded-1",
      orderingKey: "shop_1:checkout_1",
      eventType: "checkout.created",
      payload: {
        checkoutToken: "checkout_1",
        cartToken: null,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: "2026-08-28T01:00:00Z",
      },
    };

    await queueModule.publishShopifyCheckoutCreatedEvent({
      event: parseShopifyRecoveryEventV2(checkoutEvent),
    });

    expect(queues.checkout.options.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });
    expect(queues.checkout.options.telemetry).toBe(bullMQTelemetry);
  });

  it("uses the same shared telemetry object without changing job data", async () => {
    const event = parseShopifyRecoveryEventV2({
      schemaVersion: 2,
      receiptId: "r-telemetry-1",
      deliveryId: "d-telemetry-1",
      eventId: "e-telemetry-1",
      source: "shopify",
      providerTopic: "ORDERS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      receivedAt: "2026-08-28T00:00:01.000Z",
      traceId: "trace-telemetry-1",
      orderingKey: "shop_1:gid://shopify/Order/telemetry-1",
      eventType: "order.completed",
      payload: {
        orderId: "gid://shopify/Order/telemetry-1",
        checkoutToken: null,
        cartToken: null,
        completedAt: "2026-08-28T00:00:00Z",
      },
    });

    await queueModule.publishShopifyOrderCompletedEvent({ event });

    expect(queues.order.options.telemetry).toBe(bullMQTelemetry);
    expect(queues.order.addCalls[0].data).toEqual(event);
  });

  it("fails publication when Redis is unavailable", async () => {
    await queueModule.resetShopifyWebhookQueuesForTests();
    delete process.env.REDIS_URL;

    await expect(
      queueModule.publishShopifyOrderCompletedEvent({
        event: parseShopifyRecoveryEventV2({
          schemaVersion: 2,
          receiptId: "r1",
          deliveryId: "d1",
          eventId: "e1",
          source: "shopify",
          providerTopic: "ORDERS_CREATE",
          tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
          occurredAt: "2026-08-28T00:00:00.000Z",
          receivedAt: "2026-08-28T00:00:01.000Z",
          traceId: "r1",
          orderingKey: "shop_1:gid://shopify/Order/1",
          eventType: "order.completed",
          payload: {
            orderId: "gid://shopify/Order/1",
            checkoutToken: null,
            cartToken: null,
            completedAt: "2026-08-28T00:00:00Z",
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "REDIS_UNAVAILABLE" });
  });
});