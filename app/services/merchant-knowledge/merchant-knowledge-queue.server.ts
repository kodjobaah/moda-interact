import { recordMerchantKnowledgeFailure } from "./merchant-knowledge-observability.server";
import { Queue } from "bullmq";
import {
  MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME,
  MERCHANT_KNOWLEDGE_PROCESS_SCHEMA_VERSION,
  MERCHANT_KNOWLEDGE_QUEUE_NAME,
  MerchantKnowledgeProcessSourceRevisionJobSchema,
} from "@modainteract/moda-interact-shared/merchant-knowledge";
import { createMerchantKnowledgeProcessJobId } from "@modainteract/moda-interact-shared/merchant-knowledge/node";

type KnowledgeQueue = Pick<Queue, "add">;

let queue: Queue | null = null;
let queueUrl: string | null = null;

async function getQueue(): Promise<KnowledgeQueue | null> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return null;
  if (queue && queueUrl === redisUrl) return queue;
  if (queue) { await queue.close(); queue = null; queueUrl = null; }
  queue = new Queue(MERCHANT_KNOWLEDGE_QUEUE_NAME, {
    connection: {
      url: redisUrl,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_500,
      commandTimeout: 2_500,
    },
  });
  queueUrl = redisUrl;
  return queue;
}

export async function enqueueMerchantKnowledgeRevisionBestEffort(
  input: {
    shopId: string;
    sourceRevisionId: string;
    generation: number;
    requestedAt: Date;
  },
  injectedQueue?: KnowledgeQueue | null,
): Promise<boolean> {
  try {
    const targetQueue = injectedQueue === undefined ? await getQueue() : injectedQueue;
    if (!targetQueue) throw new Error("Merchant knowledge queue configuration is unavailable.");
    const data = MerchantKnowledgeProcessSourceRevisionJobSchema.parse({
      schemaVersion: MERCHANT_KNOWLEDGE_PROCESS_SCHEMA_VERSION,
      shopId: input.shopId,
      sourceRevisionId: input.sourceRevisionId,
      generation: input.generation,
      requestedAt: input.requestedAt.toISOString(),
    });
    await targetQueue.add(MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME, data, {
      jobId: createMerchantKnowledgeProcessJobId(input),
    });
    return true;
  } catch (error) {
    recordMerchantKnowledgeFailure({shopId: input.shopId, operation: "queue", error, origin: error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^E[A-Z_]+$/.test(error.code) ? "transport" : "internal", warn: true});
    // The revision is durable before this queue hint is published.
    return false;
  }
}

export async function resetMerchantKnowledgeQueueForTests(): Promise<void> {
  if (queue) await queue.close();
  queue = null;
  queueUrl = null;
}