import { describe, expect, it, vi } from "vitest";

import {
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
} from "@modainteract/moda-interact-shared/billing";
import { enqueueBillingSubscriptionReconcileBestEffort } from "../../../app/services/billing/billing-reconciliation.service";

async function captureSharedErrorRecords(
  run: () => Promise<unknown>,
  options: { throwFromSink?: boolean } = {},
) {
  const records: Array<Record<string, unknown>> = [];
  const sink = vi.spyOn(console, "error").mockImplementation((line) => {
    if (options.throwFromSink) throw new Error("test Shared sink failure");
    if (typeof line !== "string") return;
    try { records.push(JSON.parse(line) as Record<string, unknown>); } catch { return; }
  });
  try { await run(); } finally { sink.mockRestore(); }
  return records;
}

describe("billing reconciliation producer", () => {
  it("uses the shared contract and deterministic delayed job identity", async () => {
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const expectedNextReconcileAt = new Date(Date.now() + 60_000);

    await enqueueBillingSubscriptionReconcileBestEffort(
      {
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        expectedNextReconcileAt,
      },
      queue,
    );

    expect(queue.add).toHaveBeenCalledWith(
      BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
      {
        schemaVersion: BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        expectedNextReconcileAt: expectedNextReconcileAt.toISOString(),
      },
      expect.objectContaining({
        jobId: expect.stringMatching(/^billing-subscription-reconcile-/),
        delay: expect.any(Number),
      }),
    );
  });

  it("isolates queue add failures", async () => {
    const cause = new Error("Redis socket marker merchant@example.com");
    const failure = new Error("Redis queue marker password=redis-secret", { cause });
    const queue = { add: vi.fn().mockRejectedValue(failure) };

    const records = await captureSharedErrorRecords(async () => {
      await expect(enqueueBillingSubscriptionReconcileBestEffort(
        {
          shopId: "shop-1",
          subscriptionId: "subscription-1",
          expectedNextReconcileAt: new Date(),
        },
        queue,
      )).resolves.toBeUndefined();
    });
    const record = records.find((item) => item.event === "billing.subscription_reconcile.enqueue_failed");
    const data = record?.data as Record<string, unknown>;

    expect(data).toMatchObject({
      operation: "enqueue_billing_subscription_reconcile",
      stage: "queue_add",
      origin: "transport",
      shopId: "shop-1",
      identities: {
        subscriptionId: "subscription-1",
        expectedNextReconcileAt: expect.any(String),
      },
      error: { name: "Error", message: "Redis queue marker [REDACTED]" },
      causeChain: [{ name: "Error", message: "Redis socket marker [REDACTED]" }],
    });
    expect(JSON.stringify(record)).not.toContain("redis-secret");
    expect(JSON.stringify(record)).not.toContain("merchant@example.com");

    const isolatedQueue = { add: vi.fn().mockRejectedValue(failure) };
    const isolatedRecords = await captureSharedErrorRecords(async () => {
      await expect(enqueueBillingSubscriptionReconcileBestEffort({
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        expectedNextReconcileAt: new Date(),
      }, isolatedQueue),).resolves.toBeUndefined();
    }, { throwFromSink: true });
    expect(isolatedRecords).toHaveLength(0);
    expect(isolatedQueue.add).toHaveBeenCalledOnce();
  });

  it("logs queue acquisition failure at its own best-effort boundary", async () => {
    const cause = new Error("Redis connection configuration marker merchant@example.com");
    const failure = new Error("Redis queue construction marker password=queue-secret", { cause });
    const queueFactory = vi.fn(() => { throw failure; });
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const records = await captureSharedErrorRecords(async () => {
      await expect(enqueueBillingSubscriptionReconcileBestEffort({
        shopId: "shop-2",
        subscriptionId: "subscription-2",
        expectedNextReconcileAt: new Date("2026-11-05T00:00:00.000Z"),
      }, undefined, queueFactory)).resolves.toBeUndefined();
    });
    const record = records.find((item) => item.event === "billing.subscription_reconcile.enqueue_failed");

    expect(record?.data).toMatchObject({
      operation: "enqueue_billing_subscription_reconcile",
      stage: "queue_acquisition",
      origin: "transport",
      shopId: "shop-2",
      identities: {
        subscriptionId: "subscription-2",
        expectedNextReconcileAt: "2026-11-05T00:00:00.000Z",
      },
      error: { name: "Error", message: "Redis queue construction marker [REDACTED]" },
      causeChain: [{ name: "Error", message: "Redis connection configuration marker [REDACTED]" }],
    });
    expect(JSON.stringify(record)).not.toContain("queue-secret");
    expect(JSON.stringify(record)).not.toContain("merchant@example.com");
    expect(queueFactory).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });

  it("isolates queue acquisition failures", async () => {
    const previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://localhost:6379";
    try {
      await expect(
        enqueueBillingSubscriptionReconcileBestEffort(
          {
            shopId: "shop-1",
            subscriptionId: "subscription-1",
            expectedNextReconcileAt: new Date(),
          },
          undefined,
          () => {
            throw new Error("Queue construction failed");
          },
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedisUrl;
    }
  });
});