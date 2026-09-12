import { Queue } from "bullmq";
import {
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_SCHEMA_VERSION,
  createBillingSubscriptionReconcileJobId,
} from "@modainteract/moda-interact-shared/billing";

type BillingReconciliationQueue = Pick<Queue, "add">;

let queue: Queue | null = null;
let queueUrl: string | null = null;

async function getQueue(): Promise<BillingReconciliationQueue | null> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return null;
  if (queue && queueUrl === redisUrl) return queue;
  if (queue) await queue.close();
  queueUrl = redisUrl;
  queue = new Queue(BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME, {
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
): Promise<void> {
  const targetQueue = injectedQueue === undefined ? await getQueue() : injectedQueue;
  if (!targetQueue) return;

  const expectedNextReconcileAt = input.expectedNextReconcileAt.toISOString();
  try {
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
  } catch {
    // Durable reconciliation state is committed before this best-effort hint.
  }
}