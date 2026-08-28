import { Queue } from "bullmq";
import {
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS,
  type ShopifyCheckoutCreatedEventV2,
  type ShopifyCheckoutUpdatedEventV2,
  type ShopifyOrderCompletedEventV2,
  type ShopifyRecoveryEventV2,
} from "@modainteract/moda-interact-shared/shopify";
import {
  createShopifyWebhookJobId,
  createShopifyOrderJobId,
} from "@modainteract/moda-interact-shared/shopify/node";

const JOB_PUBLISH_TIMEOUT_MS = 3_500;

type ShopifyWebhookQueueName =
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName;

type ShopifyWebhookQueueJobName =
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.jobName
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.jobName;

type ShopifyWebhookPublicationOutcome = "enqueued" | "duplicate";

export class ShopifyWebhookPublicationError extends Error {
  code: "REDIS_UNAVAILABLE" | "PUBLICATION_TIMEOUT" | "QUEUE_ADD_FAILED";

  constructor(
    message: string,
    code: "REDIS_UNAVAILABLE" | "PUBLICATION_TIMEOUT" | "QUEUE_ADD_FAILED",
  ) {
    super(message);
    this.name = "ShopifyWebhookPublicationError";
    this.code = code;
  }
}

export type ShopifyWebhookPublicationResult = {
  queue: ShopifyWebhookQueueName;
  jobId: string;
  outcome: ShopifyWebhookPublicationOutcome;
};

let checkoutQueue: Queue<
  ShopifyRecoveryEventV2,
  void,
  ShopifyWebhookQueueJobName
> | null = null;

let orderQueue: Queue<
  ShopifyRecoveryEventV2,
  void,
  ShopifyWebhookQueueJobName
> | null = null;

export async function resetShopifyWebhookQueuesForTests(): Promise<void> {
  await Promise.all([
    typeof checkoutQueue?.close === "function" ? checkoutQueue.close() : undefined,
    typeof orderQueue?.close === "function" ? orderQueue.close() : undefined,
  ]);

  checkoutQueue = null;
  orderQueue = null;
}

function getQueueConnection() {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new ShopifyWebhookPublicationError(
      "REDIS_URL is not configured",
      "REDIS_UNAVAILABLE",
    );
  }

  return {
    url: redisUrl,
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
  };
}

function getCheckoutQueue() {
  if (!checkoutQueue) {
    checkoutQueue = new Queue(
      SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName,
      {
        connection: getQueueConnection(),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      },
    );
  }

  return checkoutQueue;
}

function getOrderQueue() {
  if (!orderQueue) {
    orderQueue = new Queue(
      SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
      {
        connection: getQueueConnection(),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      },
    );
  }

  return orderQueue;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new ShopifyWebhookPublicationError(message, "PUBLICATION_TIMEOUT"),
        );
      }, timeoutMs);
    }),
  ]);
}

function isDuplicateJobError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /already exists|already been added|job has been added/i.test(error.message)
  );
}

async function addJobWithTimeout(
  queue: Queue<ShopifyRecoveryEventV2, void, ShopifyWebhookQueueJobName>,
  jobName: ShopifyWebhookQueueJobName,
  event: ShopifyRecoveryEventV2,
  options: {
    jobId: string;
    delay?: number;
  },
) {
  try {
    return await withTimeout(
      queue.add(jobName, event, {
        jobId: options.jobId,
        delay: options.delay,
      }),
      JOB_PUBLISH_TIMEOUT_MS,
      `Timed out publishing job ${options.jobId}`,
    );
  } catch (error) {
    if (isDuplicateJobError(error)) {
      return null;
    }

    if (error instanceof ShopifyWebhookPublicationError) {
      throw error;
    }

    throw new ShopifyWebhookPublicationError(
      error instanceof Error ? error.message : "Failed to publish webhook job",
      "QUEUE_ADD_FAILED",
    );
  }
}

export async function publishShopifyCheckoutCreatedEvent(input: {
  event: ShopifyCheckoutCreatedEventV2;
}): Promise<ShopifyWebhookPublicationResult> {
  const queue = getCheckoutQueue();
  const jobId = createShopifyWebhookJobId(
    input.event.tenant.shopId,
    input.event.deliveryId,
  );

  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    return {
      queue: queue.name as ShopifyWebhookQueueName,
      jobId,
      outcome: "duplicate",
    };
  }

  await addJobWithTimeout(
    queue,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName,
    input.event,
    { jobId },
  );

  return {
    queue: queue.name as ShopifyWebhookQueueName,
    jobId,
    outcome: "enqueued",
  };
}

export async function publishShopifyCheckoutUpdatedEvent(input: {
  event: ShopifyCheckoutUpdatedEventV2;
}): Promise<ShopifyWebhookPublicationResult> {
  const queue = getCheckoutQueue();
  const jobId = createShopifyWebhookJobId(
    input.event.tenant.shopId,
    input.event.deliveryId,
  );

  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    return {
      queue: queue.name as ShopifyWebhookQueueName,
      jobId,
      outcome: "duplicate",
    };
  }

  await addJobWithTimeout(
    queue,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.jobName,
    input.event,
    { jobId },
  );

  return {
    queue: queue.name as ShopifyWebhookQueueName,
    jobId,
    outcome: "enqueued",
  };
}

export async function publishShopifyOrderCompletedEvent(input: {
  event: ShopifyOrderCompletedEventV2;
}): Promise<ShopifyWebhookPublicationResult> {
  const queue = getOrderQueue();
  const jobId = createShopifyOrderJobId(
    input.event.tenant.shopId,
    input.event.payload.orderId,
  );

  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    return {
      queue: queue.name as ShopifyWebhookQueueName,
      jobId,
      outcome: "duplicate",
    };
  }

  await addJobWithTimeout(
    queue,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.jobName,
    input.event,
    { jobId },
  );

  return {
    queue: queue.name as ShopifyWebhookQueueName,
    jobId,
    outcome: "enqueued",
  };
}
