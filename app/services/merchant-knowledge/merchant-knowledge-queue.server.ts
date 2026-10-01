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
  if (queue) await queue.close();
  queueUrl = redisUrl;
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
    if (!targetQueue) return false;
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
  } catch {
    // The revision is durable before this queue hint is published.
    return false;
  }
}

export async function resetMerchantKnowledgeQueueForTests(): Promise<void> {
  if (queue) await queue.close();
  queue = null;
  queueUrl = null;
}