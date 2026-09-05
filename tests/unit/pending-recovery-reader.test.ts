import { beforeEach, describe, expect, it, vi } from "vitest";

const zsets = new Map<string, Array<[string, number]>>();
const jobs = new Map<string, { name: string; data: Record<string, unknown>; state: string }>();
let redisShouldFail = false;

class FakeRedis {
  on() {
    return this;
  }

  async connect() {
    if (redisShouldFail) throw new Error("redis unavailable");
  }

  async zcard(key: string) {
    return zsets.get(key)?.length ?? 0;
  }

  async zrange(key: string, start: number, stop: number, mode: string) {
    expect(mode).toBe("WITHSCORES");
    return (zsets.get(key) ?? [])
      .slice(start, stop + 1)
      .flatMap(([member, score]) => [member, String(score)]);
  }

  disconnect() {}
}

class FakeQueue {
  async getJob(id: string) {
    const job = jobs.get(id);
    if (!job) return undefined;
    return {
      id,
      name: job.name,
      data: job.data,
      getState: async () => job.state,
    };
  }

  async close() {}
}

vi.mock("ioredis", () => ({ default: FakeRedis }));
vi.mock("bullmq", () => ({ Queue: FakeQueue }));

const { readPendingRecoveries } = await import(
  "../../app/services/pending-recovery/pending-recovery-reader.server"
);

describe("pending recovery reader", () => {
  beforeEach(() => {
    process.env.REDIS_URL = "redis://test";
    redisShouldFail = false;
    zsets.clear();
    jobs.clear();
  });

  it("reads only the authenticated shop's active jobs and redacts candidate data", async () => {
    zsets.set("pending-recovery:index:shop:shop-1", [
      ["job-active", 1_700_000_000_000],
      ["job-failed", 1_700_000_001_000],
      ["job-other-shop", 1_700_000_002_000],
      ["job-wrong-name", 1_700_000_003_000],
    ]);
    jobs.set("job-active", {
      name: "evaluate-pending-recovery",
      state: "active",
      data: {
        shopId: "shop-1",
        shopDomain: "SHOP-1.MYSHOPIFY.COM",
        checkoutCreatedAt: "2026-09-05T08:00:00Z",
        checkoutToken: "secret-checkout",
        cartToken: "secret-cart",
        abandonedCheckoutUrl: "https://secret.example/recovery",
      },
    });
    jobs.set("job-failed", {
      name: "evaluate-pending-recovery",
      state: "failed",
      data: { shopId: "shop-1", shopDomain: "shop-1.myshopify.com" },
    });
    jobs.set("job-other-shop", {
      name: "evaluate-pending-recovery",
      state: "waiting",
      data: { shopId: "shop-2", shopDomain: "shop-1.myshopify.com" },
    });
    jobs.set("job-wrong-name", {
      name: "other-job",
      state: "waiting",
      data: { shopId: "shop-1", shopDomain: "shop-1.myshopify.com" },
    });

    const result = await readPendingRecoveries({
      shopId: "shop-1",
      shopDomain: "shop-1.myshopify.com",
      page: 1,
    });

    expect(result).toMatchObject({ available: true, page: 1, total: 4, totalPages: 1 });
    expect(result.items).toEqual([{
      id: "job-active",
      status: "active",
      checkoutCreatedAt: "2026-09-05T08:00:00Z",
      scheduledFor: "2023-11-14T22:13:20.000Z",
    }]);
    expect(JSON.stringify(result)).not.toContain("secret-checkout");
    expect(JSON.stringify(result)).not.toContain("secret-cart");
    expect(JSON.stringify(result)).not.toContain("secret.example");
  });

  it("uses a shop-scoped page of ten members and clamps invalid pages", async () => {
    const members = Array.from({ length: 12 }, (_, index) => [`job-${index}`, 1_700_000_000_000 + index] as [string, number]);
    zsets.set("pending-recovery:index:shop:shop-1", members);
    for (const [id] of members) {
      jobs.set(id, {
        name: "evaluate-pending-recovery",
        state: "delayed",
        data: { shopId: "shop-1", shopDomain: "shop-1.myshopify.com" },
      });
    }

    const result = await readPendingRecoveries({
      shopId: "shop-1",
      shopDomain: "shop-1.myshopify.com",
      page: 0,
    });

    expect(result).toMatchObject({ available: true, page: 1, pageSize: 10, total: 12, totalPages: 2 });
    expect(result.items).toHaveLength(10);
  });

  it("returns a safe unavailable state when Redis cannot be read", async () => {
    redisShouldFail = true;

    await expect(readPendingRecoveries({
      shopId: "shop-1",
      shopDomain: "shop-1.myshopify.com",
      page: 2,
    })).resolves.toEqual({
      available: false,
      page: 2,
      pageSize: 10,
      total: 0,
      totalPages: 0,
      items: [],
    });
  });
});
