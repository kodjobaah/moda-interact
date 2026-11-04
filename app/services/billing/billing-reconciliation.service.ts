import { Queue } from "bullmq";
import {
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
  createBillingSubscriptionReconcileJobId,
} from "@modainteract/moda-interact-shared/billing";
import { logBillingBoundaryFailure } from "./providers/shopify-billing-diagnostics.server";

type BillingReconciliationQueue = Pick<Queue, "add"> & {
  close?: () => Promise<unknown>;
};
type BillingReconciliationQueueFactory = (
  name: string,
  options: ConstructorParameters<typeof Queue>[1],
) => BillingReconciliationQueue;

let queue: BillingReconciliationQueue | null = null;
let queueUrl: string | null = null;

const createQueue: BillingReconciliationQueueFactory = (name, options) => new Queue(name, options);

async function getQueue(
  queueFactory: BillingReconciliationQueueFactory = createQueue,
): Promise<BillingReconciliationQueue | null> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return null;
  if (queue && queueUrl === redisUrl) return queue;
  if (queue) await queue.close?.();
  queueUrl = redisUrl;
  queue = queueFactory(BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME, {
    connection: {
      url: redisUrl,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_500,
      commandTimeout: 2_500,
    },
  });
  return queue;
}

export async function enqueueBillingSubscriptionReconcileBestEffort(
  input: {
    shopId: string;
    subscriptionId: string;
    expectedNextReconcileAt: Date;
  },
  injectedQueue?: BillingReconciliationQueue | null,
  injectedQueueFactory?: BillingReconciliationQueueFactory,
): Promise<void> {
  let stage: "queue_acquisition" | "queue_add" = "queue_acquisition";
  try {
    const targetQueue = injectedQueue === undefined
      ? await getQueue(injectedQueueFactory)
      : injectedQueue;
    if (!targetQueue) return;

    stage = "queue_add";
    const expectedNextReconcileAt = input.expectedNextReconcileAt.toISOString();
    await targetQueue.add(
      BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
      {
        schemaVersion: BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
        shopId: input.shopId,
        subscriptionId: input.subscriptionId,
        expectedNextReconcileAt,
      },
      {
        jobId: createBillingSubscriptionReconcileJobId(
          input.subscriptionId,
          expectedNextReconcileAt,
        ),
        delay: Math.max(input.expectedNextReconcileAt.getTime() - Date.now(), 0),
      },
    );
  } catch (error) {
    logBillingBoundaryFailure({
      event: "billing.subscription_reconcile.enqueue_failed",
      operation: "enqueue_billing_subscription_reconcile",
      stage,
      origin: "transport",
      shopId: input.shopId,
      identities: {
        subscriptionId: input.subscriptionId,
        expectedNextReconcileAt: input.expectedNextReconcileAt.toISOString(),
      },
      error,
    });
  }
}