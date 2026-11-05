import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startShopifyWebhookRedis, type ShopifyWebhookRedis } from "../helpers/shopify-webhook-redis";
import { webhookFixtures } from "../helpers/shopify-webhook-fixtures";
import * as publications from "../../app/services/webhooks/shopify-webhook-queue.server";
const publishers = {
  publishShopifyCheckoutCreatedEvent: publications.publishShopifyCheckoutCreatedEvent,
  publishShopifyCheckoutUpdatedEvent: publications.publishShopifyCheckoutUpdatedEvent,
  publishShopifyCartActivityEvent: publications.publishShopifyCartActivityEvent,
  publishShopifyOrderCompletedEvent: publications.publishShopifyOrderCompletedEvent,
  publishShopifyDiscountSyncJob: publications.publishShopifyDiscountSyncJob,
  publishShopifyWhatsAppConsentSyncJob: publications.publishShopifyWhatsAppConsentSyncJob,
};
function barrier<T = void>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const fixtures = webhookFixtures();
describe.skipIf(process.env.MODA_SHOPIFY_WEBHOOK_REDIS !== "1")("actual Shopify publication acceptance", () => {
  let fixture: ShopifyWebhookRedis;
  const inspection = new Map<string, Queue>();
  beforeAll(async () => {
    fixture = await startShopifyWebhookRedis(); vi.stubEnv("REDIS_URL", fixture.url);
    fixture.track(() => publications.resetShopifyWebhookQueuesForTests());
    for (const {contract} of fixtures) if (!inspection.has(contract.queueName)) {
      const queue = new Queue(contract.queueName, {connection: {url: fixture.url, maxRetriesPerRequest: null}});
      fixture.track(() => queue.close()); inspection.set(contract.queueName, queue); await queue.waitUntilReady();
    }
  }, 60_000);
  afterAll(async () => {vi.restoreAllMocks(); await fixture?.cleanup(); vi.unstubAllEnvs();}, 30_000);
  it.each(fixtures)("atomically accepts concurrent $publisher deliveries and separates tenants", async original => {
    const foreign = webhookFixtures("shop-b").find(row => row.publisher === original.publisher)!;
    const results = await Promise.all(Array.from({length: 12}, () => publishers[original.publisher]({event: original.event as never})));
    expect(results.every(result => result.outcome === "accepted" && result.jobId === original.jobId)).toBe(true);
    const other = await publishers[foreign.publisher]({event: foreign.event as never});
    expect(other.jobId).not.toBe(original.jobId);
    const queue = inspection.get(original.contract.queueName)!;
    expect((await queue.getJob(original.jobId))?.data).toEqual(original.event);
    expect((await queue.getJob(other.jobId))?.data).toEqual(foreign.event);
    const retained = (await queue.getJobs(["waiting"])).filter(job => job.id === original.jobId);
    expect(retained).toHaveLength(1);
    expect(retained[0].opts).toMatchObject({attempts: 3, backoff: {type: "exponential", delay: 1000}, removeOnComplete: true, removeOnFail: false});
    const reread = await publishers[original.publisher]({event: original.event as never}); expect(reread.outcome).toBe("accepted");
    process.stdout.write(`REDIS_ACCEPTANCE ${JSON.stringify({publisher: original.publisher, acceptedAdds: results.length + 1,
      retainedJobsForId: retained.length, tenantSeparated: true, jobId: original.jobId})}\n`);
  });
  it("may publish another job after successful auto-removal", async () => {
    const row = webhookFixtures("shop-replay", "removal")[4];
    const queue = inspection.get(row.contract.queueName)!;
    const done = barrier();
    const worker = new Worker(row.contract.queueName, async () => {}, {connection: {url: fixture.url, maxRetriesPerRequest: null}});
    fixture.track(() => worker.close()); worker.on("error", done.reject);
    worker.on("completed", job => {if (job.id === row.jobId) done.resolve();});
    await worker.waitUntilReady();
    expect((await publications.publishShopifyDiscountSyncJob({event: row.event})).outcome).toBe("accepted");
    await done.promise; await worker.close();
    expect(await queue.getJob(row.jobId)).toBeUndefined();
    expect((await publications.publishShopifyDiscountSyncJob({event: row.event})).outcome).toBe("accepted");
    expect(await queue.getJob(row.jobId)).toBeDefined();
    process.stdout.write(`REDIS_AUTO_REMOVAL ${JSON.stringify({jobId: row.jobId, replayMayCreateAgain: true})}\n`);
  }, 20_000);
  it("retains a late add after the HTTP publication budget and retries with the same ID", async () => {
    const warmup = webhookFixtures("shop-late", "warmup")[0];
    await publications.publishShopifyCheckoutCreatedEvent({event: warmup.event});
    const queue = inspection.get(warmup.contract.queueName)!;
    await (await queue.getJob(warmup.jobId))!.remove(); // Only this test's warmup, never the late job.
    const row = webhookFixtures("shop-late", "late")[0];
    const settled = barrier(); const entered = barrier(); let calls = 0;
    const original = Queue.prototype.add;
    const spy = vi.spyOn(Queue.prototype, "add").mockImplementation(function (this: Queue, ...args: Parameters<Queue["add"]>) {
      calls++; const promise = original.apply(this, args);
      if (calls === 1) {entered.resolve(); promise.then(() => settled.resolve(), settled.reject);}
      return promise;
    });
    try {
      await fixture.control.call("CLIENT", "PAUSE", "20000", "WRITE");
      const attempt = publications.publishShopifyCheckoutCreatedEvent({event: row.event});
      const rejection = expect(attempt).rejects.toMatchObject({code: "PUBLICATION_TIMEOUT", stage: "deadline", jobId: row.jobId});
      await entered.promise; await rejection;
      await fixture.control.call("CLIENT", "UNPAUSE"); await settled.promise;
      expect((await queue.getJob(row.jobId))?.data).toEqual(row.event);
      expect(await publications.publishShopifyCheckoutCreatedEvent({event: row.event})).toMatchObject({outcome: "accepted", jobId: row.jobId});
      expect((await queue.getJobs(["waiting"])).filter(job => job.id === row.jobId)).toHaveLength(1);
      expect(calls).toBe(2);
      process.stdout.write(`REDIS_LATE_ADD ${JSON.stringify({jobId: row.jobId, publicationCode: "PUBLICATION_TIMEOUT", lateAddSettled: true, retry: "accepted", retainedJobs: 1})}\n`);
    } finally {await fixture.control.call("CLIENT", "UNPAUSE"); spy.mockRestore();}
  }, 20_000);
});
