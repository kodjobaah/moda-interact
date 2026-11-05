import { Queue } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import {
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS,
  parseShopifyDiscountSyncJob,
  ShopifyWhatsAppConsentSyncJobV1Schema,
  type ShopifyWhatsAppConsentSyncJobV1,
  type ShopifyDiscountSyncJob,
  type ShopifyCheckoutCreatedEventV2,
  type ShopifyCheckoutUpdatedEventV2,
  type ShopifyCheckoutUpdatedEventV3,
  type ShopifyCartActivityEventV2,
  type ShopifyOrderCompletedEventV2,
  type ShopifyRecoveryEvent,
} from "@modainteract/moda-interact-shared/shopify";
import {
  createShopifyWebhookJobId,
  createShopifyOrderJobId,
  createShopifyDiscountSyncJobId,
  createShopifyWhatsAppConsentSyncJobId,
} from "@modainteract/moda-interact-shared/shopify/node";

import { recordShopifyWebhookQueueFailure } from "./shopify-webhook-observability.server";

const JOB_PUBLISH_TIMEOUT_MS = 3_500;
const bullMQTelemetry = createBullMQTelemetry({ serviceName: "moda-interact" });
type ShopifyWebhookQueueName = typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS[keyof typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS]["queueName"];
type PublicationStage = "configuration" | "queue_acquisition" | "add" | "deadline";
type PublicationContext = { queue?: ShopifyWebhookQueueName; jobId?: string; connectionError?: unknown; release?: () => void };

export class ShopifyWebhookPublicationError extends Error {
  readonly stage: PublicationStage;
  queue?: ShopifyWebhookQueueName;
  jobId?: string;
  constructor(message: string,
    public readonly code: "REDIS_UNAVAILABLE" | "PUBLICATION_TIMEOUT" | "QUEUE_ADD_FAILED",
    options: { cause?: unknown; stage?: PublicationStage; queue?: ShopifyWebhookQueueName; jobId?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ShopifyWebhookPublicationError";
    this.stage = options.stage ?? (code === "REDIS_UNAVAILABLE" ? "configuration" : code === "PUBLICATION_TIMEOUT" ? "deadline" : "add");
    this.queue = options.queue; this.jobId = options.jobId;
  }
}
export type ShopifyWebhookPublicationResult = { queue: ShopifyWebhookQueueName; jobId: string; outcome: "accepted" };

const queues = new Map<ShopifyWebhookQueueName, Queue>();
const activePublications = new WeakMap<Queue, Set<PublicationContext>>();
export async function resetShopifyWebhookQueuesForTests(): Promise<void> {
  await Promise.all([...queues.values()].map(queue => typeof queue.close === "function" ? queue.close() : undefined));
  queues.clear();
}

function getQueue(name: ShopifyWebhookQueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new ShopifyWebhookPublicationError("REDIS_URL is not configured", "REDIS_UNAVAILABLE");
  const queue = new Queue(name, {
    connection: { url: redisUrl, enableOfflineQueue: false, maxRetriesPerRequest: null },
    telemetry: bullMQTelemetry,
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: true, removeOnFail: false },
  });
  queue.on("error", error => {
    // Active callers own publication failures. The emitter owns idle/late connection failures.
    const active = activePublications.get(queue);
    if (active?.size) {
      for (const publication of active) publication.connectionError = error;
    } else recordShopifyWebhookQueueFailure({ queue: name, stage: "connection", error });
  });
  queues.set(name, queue);
  return queue;
}

/** One timer is armed before acquisition/add. Late settlement remains observed, never cancelled. */
function withinPublicationDeadline<T>(context: PublicationContext, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = () => new ShopifyWebhookPublicationError("Timed out publishing webhook job", "PUBLICATION_TIMEOUT", { ...context, stage: "deadline", cause: context.connectionError });
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(timeout()), JOB_PUBLISH_TIMEOUT_MS);
    Promise.resolve().then(operation).then(value => {
      if (Date.now() - startedAt >= JOB_PUBLISH_TIMEOUT_MS) reject(timeout());
      else resolve(value);
    }, error => reject(Date.now() - startedAt >= JOB_PUBLISH_TIMEOUT_MS ? timeout() : error));
  }).finally(() => { clearTimeout(timer); context.release?.(); });
}

export function createTenantReadableJobId(shopId: string, deterministicJobId: string): string {
  if (!shopId || !deterministicJobId) throw new Error("Tenant-readable job IDs require non-empty values");
  return `${shopId}--${deterministicJobId}`;
}

type PublicationContract = { queueName: ShopifyWebhookQueueName; jobName: string };
function publish<T>(contract: PublicationContract, build: () => { event: T; jobId: string }): Promise<ShopifyWebhookPublicationResult> {
  const context: PublicationContext = { queue: contract.queueName };
  return withinPublicationDeadline(context, async () => {
    const { event, jobId } = build(); context.jobId = jobId;
    let queue: Queue;
    try { queue = getQueue(contract.queueName); }
    catch (error) {
      if (error instanceof ShopifyWebhookPublicationError) {
        error.queue = context.queue; error.jobId = jobId; throw error;
      }
      throw new ShopifyWebhookPublicationError("Failed to acquire webhook queue", "QUEUE_ADD_FAILED", { ...context, stage: "queue_acquisition", cause: error });
    }
    const active = activePublications.get(queue) ?? new Set<PublicationContext>();
    active.add(context); activePublications.set(queue, active);
    context.release = () => { active.delete(context); };
    try { await queue.add(contract.jobName, event, { jobId }); }
    catch (error) {
      throw new ShopifyWebhookPublicationError("Failed to publish webhook job", "QUEUE_ADD_FAILED", { ...context, stage: "add", cause: error });
    }
    return { queue: contract.queueName, jobId, outcome: "accepted" };
  });
}

function deliveryJobId(event: ShopifyRecoveryEvent): string {
  return createTenantReadableJobId(event.tenant.shopId, createShopifyWebhookJobId(event.tenant.shopId, event.deliveryId));
}
export async function publishShopifyCheckoutCreatedEvent(input: { event: ShopifyCheckoutCreatedEventV2 }): Promise<ShopifyWebhookPublicationResult> {
  return publish(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS, () => ({ event: input.event, jobId: deliveryJobId(input.event) }));
}
export async function publishShopifyCheckoutUpdatedEvent(input: { event: ShopifyCheckoutUpdatedEventV2 | ShopifyCheckoutUpdatedEventV3 }): Promise<ShopifyWebhookPublicationResult> {
  return publish(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS, () => ({ event: input.event, jobId: deliveryJobId(input.event) }));
}
export async function publishShopifyCartActivityEvent(input: { event: ShopifyCartActivityEventV2 }): Promise<ShopifyWebhookPublicationResult> {
  return publish(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CART_ACTIVITY_EVENTS, () => ({ event: input.event, jobId: deliveryJobId(input.event) }));
}
export async function publishShopifyOrderCompletedEvent(input: { event: ShopifyOrderCompletedEventV2 }): Promise<ShopifyWebhookPublicationResult> {
  return publish(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS, () => ({ event: input.event,
    jobId: createTenantReadableJobId(input.event.tenant.shopId, createShopifyOrderJobId(input.event.tenant.shopId, input.event.payload.orderId)) }));
}
export async function publishShopifyDiscountSyncJob(input: { event: ShopifyDiscountSyncJob }): Promise<ShopifyWebhookPublicationResult> {
  return publish(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.SHOPIFY_DISCOUNT_SYNC, () => {
    const event = parseShopifyDiscountSyncJob(input.event);
    return { event, jobId: createShopifyDiscountSyncJobId(event) };
  });
}
export async function publishShopifyWhatsAppConsentSyncJob(input: { event: ShopifyWhatsAppConsentSyncJobV1 }): Promise<ShopifyWebhookPublicationResult> {
  return publish(SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC, () => {
    const event = ShopifyWhatsAppConsentSyncJobV1Schema.parse(input.event);
    return { event, jobId: createShopifyWhatsAppConsentSyncJobId(event) };
  });
}
