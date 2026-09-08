import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

import {
  AuthoredSupportBodySchema,
} from "@modainteract/moda-interact-shared/merchant-communications";

import {
  composeMerchantMessage,
  markMerchantSupportMessageRead,
} from "../../app/services/merchant-support/merchant-support.service";

const supportServiceSource = await readFile(
  new URL("../../app/services/merchant-support/merchant-support.service.ts", import.meta.url),
  "utf8",
);

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

  it("uses one merchant-visible predicate for history and total pagination", () => {
    expect(supportServiceSource).toContain('const MERCHANT_VISIBLE_MESSAGE_PREDICATE = Prisma.sql`');
    expect(supportServiceSource).toContain('m."kind" = \'MERCHANT\'');
    expect(supportServiceSource).toContain('m."state" = \'AVAILABLE\'');
    expect(supportServiceSource.match(/AND \$\{MERCHANT_VISIBLE_MESSAGE_PREDICATE\}/g)).toHaveLength(2);
    expect(supportServiceSource).toContain('m."kind" IN (\'ADMINISTRATIVE\', \'SYSTEM\')');
  });

  it("only exposes an outbound source body when its required translation is available", () => {
    expect(supportServiceSource).toContain('originalBody: !translationRequired || message.translationStatus === "AVAILABLE"');
    expect(supportServiceSource).toContain('message.translationStatus === "AVAILABLE" ? message.translatedBody : null');
    expect(supportServiceSource).toContain('m."systemCode", m."systemVersion"');
    expect(supportServiceSource).toContain("systemCode: message.systemCode");
    expect(supportServiceSource).toContain("systemVersion: message.systemVersion");
  });

  it("returns true only for tenant-owned AVAILABLE outbound messages", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const queryRaw = vi.fn().mockResolvedValue([{ id: "message-1" }]);
    const database = {
      $transaction: vi.fn(async (callback) => callback({ $queryRaw: queryRaw, $executeRaw: executeRaw })),
    };

    await expect(markMerchantSupportMessageRead({
      shopId: "shop-1",
      messageId: "message-1",
      database,
    })).resolves.toBe(true);

    expect(queryRaw.mock.calls[0][0].sql).toContain('m."kind" IN (\'ADMINISTRATIVE\', \'SYSTEM\')');
    expect(queryRaw.mock.calls[0][0].sql).toContain('m."state" = \'AVAILABLE\'');
    expect(executeRaw.mock.calls[0][0].sql).toContain('"readAt" = COALESCE("readAt", NOW())');

    queryRaw.mockResolvedValue([]);
    await expect(markMerchantSupportMessageRead({
      shopId: "shop-1",
      messageId: "merchant-message",
      database,
    })).resolves.toBe(false);
    await expect(markMerchantSupportMessageRead({
      shopId: "shop-1",
      messageId: "processing-message",
      database,
    })).resolves.toBe(false);
    await expect(markMerchantSupportMessageRead({
      shopId: "other-shop",
      messageId: "message-1",
      database,
    })).resolves.toBe(false);
  });
});