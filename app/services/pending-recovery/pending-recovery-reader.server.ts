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

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("pending recovery read timed out")), READ_TIMEOUT_MS);
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

  const redis = new Redis(redisUrl, {
    connectTimeout: READ_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  const queue = new Queue(QUEUE_NAME, {
    connection: {
      url: redisUrl,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    },
  });
  redis.on("error", () => {});

  try {
    await withTimeout(redis.connect());
    const indexKey = `pending-recovery:index:shop:${shopId}`;
    const total = await withTimeout(redis.zcard(indexKey));
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const effectivePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
    const start = (effectivePage - 1) * PAGE_SIZE;
    const members = await withTimeout(redis.zrange(indexKey, start, start + PAGE_SIZE - 1, "WITHSCORES"));
    const rows: PendingRecoveryRow[] = [];

    for (let index = 0; index < members.length; index += 2) {
      const jobId = members[index];
      const score = Number(members[index + 1]);
      if (!jobId || !Number.isFinite(score)) continue;

      const job = await withTimeout(queue.getJob(jobId) as Promise<PendingRecoveryJob | undefined>);
      if (!job || job.name !== JOB_NAME) continue;
      const state = await withTimeout(job.getState());
      if (!ACTIVE_STATES.has(state)) continue;
      if (job.data.shopId !== shopId) continue;
      if (typeof job.data.shopDomain !== "string" || normalizeDomain(job.data.shopDomain) !== normalizeDomain(shopDomain)) continue;

      rows.push({
        id: jobId,
        status: state as PendingRecoveryRow["status"],
        checkoutCreatedAt: typeof job.data.checkoutCreatedAt === "string" ? job.data.checkoutCreatedAt : null,
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
  } catch {
    return unavailable(page);
  } finally {
    await queue.close().catch(() => {});
    redis.disconnect();
  }
}

export { PAGE_SIZE as PENDING_RECOVERY_PAGE_SIZE };
