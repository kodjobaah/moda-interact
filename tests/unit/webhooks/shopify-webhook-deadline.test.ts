import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webhookFixtures } from "../../helpers/shopify-webhook-fixtures";
const ports = vi.hoisted(() => ({construct: vi.fn(), add: vi.fn(), getJob: vi.fn(), on: vi.fn(), close: vi.fn()}));
vi.mock("bullmq", () => ({Queue: class {
  constructor(public name: string, options: unknown) { ports.construct(name, options); }
  add = ports.add; getJob = ports.getJob; on = ports.on; close = ports.close;
}}));
import * as publications from "../../../app/services/webhooks/shopify-webhook-queue.server";
const publishers = {
  publishShopifyCheckoutCreatedEvent: publications.publishShopifyCheckoutCreatedEvent,
  publishShopifyCheckoutUpdatedEvent: publications.publishShopifyCheckoutUpdatedEvent,
  publishShopifyCartActivityEvent: publications.publishShopifyCartActivityEvent,
  publishShopifyOrderCompletedEvent: publications.publishShopifyOrderCompletedEvent,
  publishShopifyDiscountSyncJob: publications.publishShopifyDiscountSyncJob,
  publishShopifyWhatsAppConsentSyncJob: publications.publishShopifyWhatsAppConsentSyncJob,
};
const fixtures = webhookFixtures();
function pending() { let resolve!: (value?: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; }
const publish = () => publications.publishShopifyCheckoutCreatedEvent({event: fixtures[0].event});
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubEnv("REDIS_URL", "redis://fixture.invalid");
  ports.add.mockResolvedValue({id: "ignored-returned-id"}); ports.close.mockResolvedValue(undefined);
});
afterEach(async () => { await publications.resetShopifyWebhookQueuesForTests(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("one publication deadline", () => {
  it.each(fixtures)("publishes $publisher with one add and no speculative reads", async fixture => {
    ports.construct.mockImplementationOnce(() => expect(vi.getTimerCount()).toBe(1));
    expect(await publishers[fixture.publisher]({event: fixture.event as never})).toEqual({queue: fixture.contract.queueName, jobId: fixture.jobId, outcome: "accepted"});
    expect(ports.add).toHaveBeenCalledExactlyOnceWith(fixture.contract.jobName, fixture.event, {jobId: fixture.jobId});
    expect(ports.getJob).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(ports.construct.mock.calls[0][1]).toMatchObject({defaultJobOptions: {attempts: 3,
      backoff: {type: "exponential", delay: 1000}, removeOnComplete: true, removeOnFail: false}});
  });
  it("includes queue acquisition and hanging readiness/add within 3500 ms", async () => {
    ports.construct.mockImplementationOnce(() => { vi.advanceTimersByTime(1000); });
    ports.add.mockReturnValueOnce(new Promise(() => {}));
    const result = publish(); const rejection = expect(result).rejects.toMatchObject({code: "PUBLICATION_TIMEOUT", stage: "deadline", queue: fixtures[0].contract.queueName, jobId: fixtures[0].jobId});
    await vi.advanceTimersByTimeAsync(2499); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await rejection; expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["resolve", "reject"] as const)("observes late %s without another outcome or unhandled rejection", async settle => {
    const late = pending(); ports.add.mockReturnValueOnce(late.promise);
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    try {
      const result = publish(); const rejection = expect(result).rejects.toMatchObject({code: "PUBLICATION_TIMEOUT"});
      await vi.advanceTimersByTimeAsync(3500); await rejection;
      if (settle === "resolve") late.resolve({id: "late"}); else late.reject(new Error("late driver failure"));
      await vi.advanceTimersByTimeAsync(0); expect(unhandled).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
      expect(await publish()).toMatchObject({jobId: fixtures[0].jobId, outcome: "accepted"});
      expect(ports.add.mock.calls.map(call => call[2].jobId)).toEqual([fixtures[0].jobId, fixtures[0].jobId]);
    } finally { process.off("unhandledRejection", unhandled); }
  });
  it("retains constructor failure cause and known identity", async () => {
    const cause = Object.assign(new Error("constructor marker"), {code: "ECONNREFUSED"});
    ports.construct.mockImplementationOnce(() => {throw cause;});
    await expect(publish()).rejects.toMatchObject({code: "QUEUE_ADD_FAILED", stage: "queue_acquisition", cause, jobId: fixtures[0].jobId});
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not reinterpret duplicate-looking rejection text as acceptance", async () => {
    const cause = new Error("job already exists but driver rejected"); ports.add.mockRejectedValueOnce(cause);
    await expect(publish()).rejects.toMatchObject({code: "QUEUE_ADD_FAILED", stage: "add", cause});
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses an internal configuration error without fabricating a cause", async () => {
    vi.stubEnv("REDIS_URL", "");
    const error = await publish().catch(error => error);
    expect(error).toMatchObject({code: "REDIS_UNAVAILABLE", stage: "configuration", jobId: fixtures[0].jobId});
    expect(error.cause).toBeUndefined(); expect(ports.add).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("enforces elapsed budget even when acquisition blocks timer delivery before rejection", async () => {
    ports.construct.mockImplementationOnce(() => vi.setSystemTime(Date.now() + 4000));
    ports.add.mockRejectedValueOnce(new Error("late source error"));
    await expect(publish()).rejects.toMatchObject({code: "PUBLICATION_TIMEOUT", stage: "deadline"});
    expect(vi.getTimerCount()).toBe(0);
  });
});
