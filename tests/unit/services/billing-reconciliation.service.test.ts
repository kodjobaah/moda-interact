import { describe, expect, it, vi } from "vitest";

import {
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
} from "@modainteract/moda-interact-shared/billing";
import { enqueueBillingSubscriptionReconcileBestEffort } from "../../../app/services/billing/billing-reconciliation.service";

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
    const queue = { add: vi.fn().mockRejectedValue(new Error("Redis unavailable")) };

    await expect(
      enqueueBillingSubscriptionReconcileBestEffort(
        {
          shopId: "shop-1",
          subscriptionId: "subscription-1",
          expectedNextReconcileAt: new Date(),
        },
        queue,
      ),
    ).resolves.toBeUndefined();
  });
});