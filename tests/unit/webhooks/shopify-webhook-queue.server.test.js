import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseShopifyCommerceEvent,
} from "@modainteract/moda-interact-shared/shopify";
import {
  createShopifyCheckoutJobId,
  createShopifyOrderJobId,
} from "@modainteract/moda-interact-shared/shopify/node";

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
  constructor(name) {
    this.name = name;
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
    constructor(name) {
      return name === "checkout-events" ? queues.checkout : queues.order;
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

beforeEach(() => {
  resetQueues();
});

describe("shopify webhook queue helpers", () => {
  it("creates deterministic checkout and order job ids", () => {
    const checkoutId = createShopifyCheckoutJobId("shop_1", "checkout_1");
    const orderId = createShopifyOrderJobId("shop_1", "gid://shopify/Order/1");

    expect(checkoutId).toMatch(/^checkout-/);
    expect(orderId).toMatch(/^order-created-/);
    expect(checkoutId).not.toContain(":");
    expect(orderId).not.toContain(":");
  });

  it("coalesces a newer pending checkout update into the existing delayed job", async () => {
    const baseEvent = {
      schemaVersion: 1,
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
      eventType: "checkout.observed",
      payload: {
        checkoutToken: "checkout_1",
        cartToken: "cart_1",
        checkoutUrl: null,
        customer: null,
        total: null,
        lineItems: [],
        checkoutCreatedAt: "2026-08-28T00:00:00Z",
        checkoutUpdatedAt: "2026-08-28T00:00:00Z",
        completedAt: null,
      },
    };

    await queueModule.publishShopifyCheckoutObservedEvent({
      event: parseShopifyCommerceEvent(baseEvent),
      recoveryDelayMinutes: 45,
    });

    const jobId = createShopifyCheckoutJobId("shop_1", "checkout_1");
    const existingJob = await queues.checkout.getJob(jobId);
    existingJob.state = "delayed";

    const updatedEvent = {
      ...baseEvent,
      receiptId: "r2",
      deliveryId: "d2",
      eventId: "e2",
      occurredAt: "2026-08-28T00:10:00.000Z",
      receivedAt: "2026-08-28T00:10:01.000Z",
      payload: {
        ...baseEvent.payload,
        checkoutUpdatedAt: "2026-08-28T00:10:00Z",
        completedAt: "2026-08-28T00:12:00Z",
      },
    };

    const result = await queueModule.publishShopifyCheckoutObservedEvent({
      event: parseShopifyCommerceEvent(updatedEvent),
      recoveryDelayMinutes: 45,
    });

    expect(result.outcome).toBe("coalesced");
    expect(existingJob.updatedData.payload.completedAt).toBe("2026-08-28T00:12:00Z");
    expect(existingJob.delayChanges).toEqual([45 * 60 * 1000]);
  });

  it("keeps order publication immediate and suppresses duplicate order work", async () => {
    const orderEvent = {
      schemaVersion: 1,
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
        shopifyCustomerId: null,
        total: null,
        completedAt: "2026-08-28T00:00:00Z",
      },
    };

    const first = await queueModule.publishShopifyOrderCompletedEvent({
      event: parseShopifyCommerceEvent(orderEvent),
    });

    const second = await queueModule.publishShopifyOrderCompletedEvent({
      event: parseShopifyCommerceEvent(orderEvent),
    });

    expect(first.outcome).toBe("enqueued");
    expect(second.outcome).toBe("duplicate");
    expect(queues.order.addCalls).toHaveLength(1);
  });

  it("fails publication when Redis is unavailable", async () => {
    await queueModule.resetShopifyWebhookQueuesForTests();
    delete process.env.REDIS_URL;

    await expect(
      queueModule.publishShopifyOrderCompletedEvent({
        event: parseShopifyCommerceEvent({
          schemaVersion: 1,
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
            shopifyCustomerId: null,
            total: null,
            completedAt: "2026-08-28T00:00:00Z",
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "REDIS_UNAVAILABLE" });
  });
});