import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ construct: vi.fn(), add: vi.fn() }));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor() {
      mocks.construct();
    }
  },
}));

import { enqueueMerchantKnowledgeRevisionBestEffort } from "../../app/services/merchant-knowledge/merchant-knowledge-queue.server";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
});

it("contains queue-construction failure after the revision has committed", async () => {
  mocks.construct.mockImplementation(() => {
    throw new Error("Redis unavailable");
  });

  await expect(
    enqueueMerchantKnowledgeRevisionBestEffort({
      shopId: "shop-1",
      sourceRevisionId: "revision-1",
      generation: 1,
      requestedAt: new Date("2026-10-01T12:00:00.000Z"),
    }),
  ).resolves.toBe(false);

  expect(mocks.construct).toHaveBeenCalledOnce();
});

it("contains queue-publication failure after the revision has committed", async () => {
  mocks.add.mockRejectedValue(new Error("Redis unavailable"));

  await expect(
    enqueueMerchantKnowledgeRevisionBestEffort(
      {
        shopId: "shop-1",
        sourceRevisionId: "revision-1",
        generation: 1,
        requestedAt: new Date("2026-10-01T12:00:00.000Z"),
      },
      { add: mocks.add },
    ),
  ).resolves.toBe(false);

  expect(mocks.add).toHaveBeenCalledOnce();
});

it("reports successful queue publication", async () => {
  mocks.add.mockResolvedValue({});

  await expect(
    enqueueMerchantKnowledgeRevisionBestEffort(
      {
        shopId: "shop-1",
        sourceRevisionId: "revision-1",
        generation: 1,
        requestedAt: new Date("2026-10-01T12:00:00.000Z"),
      },
      { add: mocks.add },
    ),
  ).resolves.toBe(true);
});