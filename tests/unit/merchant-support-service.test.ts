import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthoredSupportBodySchema,
} from "@modainteract/moda-interact-shared/merchant-communications";

import { composeMerchantMessage } from "../../app/services/merchant-support/merchant-support.service";

function databaseFor(languageTag: string) {
  const transaction = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ defaultLanguageTag: languageTag }])
      .mockResolvedValueOnce([{ id: "thread-1" }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  return {
    transaction,
    database: {
      $transaction: vi.fn(async (callback) => callback(transaction)),
    },
  };
}

describe("merchant support compose", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("enforces the shared 500-grapheme authored-body contract", () => {
    expect(AuthoredSupportBodySchema.safeParse("👩‍💻".repeat(500)).success).toBe(true);
    expect(AuthoredSupportBodySchema.safeParse("👩‍💻".repeat(501)).success).toBe(false);
  });

  it("makes English messages available without creating translation work", async () => {
    const { database, transaction } = databaseFor("en-US");
    const queue = { add: vi.fn() };

    const result = await composeMerchantMessage({
      shopId: "shop-1",
      body: "Please help with this order.",
      database,
      queue,
    });

    expect(result.translationId).toBeNull();
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(2);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("persists non-English translation work before best-effort dispatch", async () => {
    const { database, transaction } = databaseFor("fr-CA");
    const queue = { add: vi.fn().mockRejectedValue(new Error("Redis unavailable")) };

    const result = await composeMerchantMessage({
      shopId: "shop-1",
      body: "Bonjour, pouvez-vous m'aider?",
      database,
      queue,
    });

    expect(result.translationId).toEqual(expect.any(String));
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(3);
    expect(queue.add).toHaveBeenCalledWith(
      "translation-dispatch",
      expect.objectContaining({ translationId: result.translationId, schemaVersion: 1 }),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });

  it("rejects invalid bodies before opening a transaction", async () => {
    const database = { $transaction: vi.fn() };

    await expect(composeMerchantMessage({
      shopId: "shop-1",
      body: "",
      database,
    })).rejects.toThrow();
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});