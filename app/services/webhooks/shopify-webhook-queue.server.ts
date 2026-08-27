import { Queue } from "bullmq";
import {
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS,
  parseShopifyCommerceEvent,
  type ShopifyCheckoutObservedEvent,
  type ShopifyCommerceEvent,
  type ShopifyOrderCompletedEvent,
} from "@modainteract/moda-interact-shared/shopify";
import {
  createShopifyCheckoutJobId,
  createShopifyOrderJobId,
} from "@modainteract/moda-interact-shared/shopify/node";

const JOB_PUBLISH_TIMEOUT_MS = 3_500;

type ShopifyWebhookQueueName =
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName;

type ShopifyWebhookQueueJobName =
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName
  | typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.jobName;

type ShopifyWebhookPublicationOutcome = "enqueued" | "coalesced" | "duplicate";

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
  ShopifyCommerceEvent,
  void,
  ShopifyWebhookQueueJobName
> | null = null;

let orderQueue: Queue<
  ShopifyCommerceEvent,
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
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
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
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
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

function toMillis(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getCheckoutStateSortKey(event: ShopifyCommerceEvent): number {
  if (event.eventType !== "checkout.observed") {
    return 0;
  }

  return Math.max(
    toMillis(event.payload.completedAt),
    toMillis(event.payload.checkoutUpdatedAt),
    toMillis(event.payload.checkoutCreatedAt),
    toMillis(event.occurredAt),
    toMillis(event.receivedAt),
  );
}

function mergeCheckoutObservedEvent(
  current: ShopifyCheckoutObservedEvent,
  next: ShopifyCheckoutObservedEvent,
): ShopifyCheckoutObservedEvent {
  return {
    ...next,
    payload: {
      ...next.payload,
      checkoutToken: next.payload.checkoutToken || current.payload.checkoutToken,
      cartToken: next.payload.cartToken ?? current.payload.cartToken,
      checkoutUrl: next.payload.checkoutUrl ?? current.payload.checkoutUrl,
      customer: next.payload.customer ?? current.payload.customer,
      total: next.payload.total ?? current.payload.total,
      lineItems:
        next.payload.lineItems.length > 0
          ? next.payload.lineItems
          : current.payload.lineItems,
      checkoutCreatedAt:
        next.payload.checkoutCreatedAt ?? current.payload.checkoutCreatedAt,
      checkoutUpdatedAt:
        next.payload.checkoutUpdatedAt ?? current.payload.checkoutUpdatedAt,
      completedAt: next.payload.completedAt ?? current.payload.completedAt,
    },
  };
}

async function addJobWithTimeout(
  queue: Queue<ShopifyCommerceEvent, void, ShopifyWebhookQueueJobName>,
  jobName: ShopifyWebhookQueueJobName,
  event: ShopifyCommerceEvent,
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

export async function publishShopifyCheckoutObservedEvent(input: {
  event: ShopifyCheckoutObservedEvent;
  recoveryDelayMinutes: number;
}): Promise<ShopifyWebhookPublicationResult> {
  const queue = getCheckoutQueue();
  const jobId = createShopifyCheckoutJobId(
    input.event.tenant.shopId,
    input.event.payload.checkoutToken,
  );

  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    const currentEvent = parseShopifyCommerceEvent(existingJob.data);
    const currentSortKey = getCheckoutStateSortKey(currentEvent);
    const candidateSortKey = getCheckoutStateSortKey(input.event);

    if (candidateSortKey <= currentSortKey) {
      return {
        queue: queue.name as ShopifyWebhookQueueName,
        jobId,
        outcome: "duplicate",
      };
    }

    const state = await existingJob.getState();
    const mergedEvent = mergeCheckoutObservedEvent(
      currentEvent as ShopifyCheckoutObservedEvent,
      input.event,
    );

    await existingJob.updateData(mergedEvent);

    if (state === "delayed") {
      await existingJob.changeDelay(input.recoveryDelayMinutes * 60_000);
    }

    return {
      queue: queue.name as ShopifyWebhookQueueName,
      jobId,
      outcome: "coalesced",
    };
  }

  await addJobWithTimeout(
    queue,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName,
    input.event,
    {
      jobId,
      delay: input.recoveryDelayMinutes * 60_000,
    },
  );

  return {
    queue: queue.name as ShopifyWebhookQueueName,
    jobId,
    outcome: "enqueued",
  };
}

export async function publishShopifyOrderCompletedEvent(input: {
  event: ShopifyOrderCompletedEvent;
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
