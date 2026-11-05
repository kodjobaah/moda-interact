import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";
import Redis from "ioredis";
import { Queue } from "bullmq";

const QUEUE_NAME = "pending-recovery-candidates";
const JOB_NAME = "evaluate-pending-recovery";
const PAGE_SIZE = 10;
const READ_TIMEOUT_MS = 2_500;
const ACTIVE_STATES = new Set(["delayed", "waiting", "active"]);

type PendingRecoveryJobData = {
  shopId?: unknown;
  shopDomain?: unknown;
  checkoutCreatedAt?: unknown;
  lastActivityAt?: unknown;
};

type PendingRecoveryJob = {
  id: string;
  name: string;
  data: PendingRecoveryJobData;
  getState(): Promise<string>;
};

export type PendingRecoveryRow = {
  id: string;
  status: "delayed" | "waiting" | "active";
  checkoutCreatedAt: string | null;
  lastActivityAt: string | null;
  scheduledFor: string;
};

export type PendingRecoveryPage = {
  available: true;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: PendingRecoveryRow[];
} | {
  available: false;
  page: number;
  pageSize: number;
  total: 0;
  totalPages: 0;
  items: [];
};

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function clampPage(page: number): number {
  return Number.isInteger(page) && page > 0 ? page : 1;
}

class PendingRecoveryReadTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new PendingRecoveryReadTimeout("pending recovery read timed out")), READ_TIMEOUT_MS);
    }),
  ]);
}

function unavailable(page: number): PendingRecoveryPage {
  return {
    available: false,
    page,
    pageSize: PAGE_SIZE,
    total: 0,
    totalPages: 0,
    items: [],
  };
}

export async function readPendingRecoveries({
  shopId,
  shopDomain,
  page: requestedPage,
}: {
  shopId: string;
  shopDomain: string;
  page: number;
}): Promise<PendingRecoveryPage> {
  const page = clampPage(requestedPage);
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || !shopId || !shopDomain) return unavailable(page);

  let redis: Redis; let queue: Queue | undefined; let stage = "redis_constructor";
  const failure = (error: unknown, failedStage = stage) => logBillingBoundaryFailure({
    event: "shopify.pending_recovery.read_failed", operation: "read_pending_recoveries", stage: failedStage,
    origin: failedStage.endsWith("constructor") || failedStage === "row_projection" || error instanceof PendingRecoveryReadTimeout ? "internal" : "transport", shopId, error,
  });
  try { redis = new Redis(redisUrl, {
    connectTimeout: READ_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: () => null,
  }); } catch (error) {failure(error); throw error;}
  stage = "queue_constructor";
  try { queue = new Queue(QUEUE_NAME, {
    connection: {
      url: redisUrl,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    },
  }); } catch (error) {failure(error); try {redis.disconnect();} catch (cleanup) {failure(cleanup, "redis_cleanup");} throw error;}
  // Preserve connection evidence even if the read later fails with a generic error/timeout.
  const onError = (error: unknown) => failure(error, "error_event");
  redis.on("error", onError); queue.on("error", onError);

  try {
    stage = "redis_connect"; await withTimeout(redis.connect());
    const indexKey = `pending-recovery:index:shop:${shopId}`;
    stage = "index_count";
    const total = await withTimeout(redis.zcard(indexKey));
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const effectivePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
    const start = (effectivePage - 1) * PAGE_SIZE;
    stage = "index_page";
    const members = await withTimeout(
      redis.zrange(indexKey, start, String(start + PAGE_SIZE - 1), "WITHSCORES"),
    );
    const rows: PendingRecoveryRow[] = [];

    for (let index = 0; index < members.length; index += 2) {
      const jobId = members[index];
      const score = Number(members[index + 1]);
      if (!jobId || !Number.isFinite(score)) continue;

      stage = "queue_read";
      const job = await withTimeout(queue.getJob(jobId) as Promise<PendingRecoveryJob | undefined>);
      if (!job || job.name !== JOB_NAME) continue;
      stage = "job_state";
      const state = await withTimeout(job.getState());
      if (!ACTIVE_STATES.has(state)) continue;
      if (job.data.shopId !== shopId) continue;
      if (typeof job.data.shopDomain !== "string" || normalizeDomain(job.data.shopDomain) !== normalizeDomain(shopDomain)) continue;

      stage = "row_projection";
      rows.push({
        id: jobId,
        status: state as PendingRecoveryRow["status"],
        checkoutCreatedAt: typeof job.data.checkoutCreatedAt === "string" ? job.data.checkoutCreatedAt : null,
        lastActivityAt: typeof job.data.lastActivityAt === "string"
          ? job.data.lastActivityAt
          : typeof job.data.checkoutCreatedAt === "string" ? job.data.checkoutCreatedAt : null,
        scheduledFor: new Date(score).toISOString(),
      });
    }

    return {
      available: true,
      page: effectivePage,
      pageSize: PAGE_SIZE,
      total,
      totalPages,
      items: rows,
    };
  } catch (error) {
    failure(error); return unavailable(page);
  } finally {
    await queue.close().catch(error => {failure(error, "queue_cleanup");});
    try {redis.disconnect();} catch (error) {failure(error, "redis_cleanup");}
  }
}

export { PAGE_SIZE as PENDING_RECOVERY_PAGE_SIZE };
