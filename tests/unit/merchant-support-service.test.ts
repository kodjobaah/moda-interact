import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

import {
  AuthoredSupportBodySchema,
} from "@modainteract/moda-interact-shared/merchant-communications";

const queuePorts = vi.hoisted(() => ({ construct: vi.fn(), close: vi.fn(), add: vi.fn(), on: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class {
  constructor() { queuePorts.construct(); }
  add = queuePorts.add;
  close = queuePorts.close;
  on = queuePorts.on;
} }));
const supportObservability = vi.hoisted(() => ({
  recordMerchantSupportQueueFailure: vi.fn(),
  recordMerchantSupportReadFailure: vi.fn(),
  recordMerchantSupportAcknowledgementFailure: vi.fn(),
  recordMerchantSupportTranslationDispatchFailure: vi.fn(),
}));
vi.mock("../../app/services/merchant-support/merchant-support-observability.server", () => ({
  ...supportObservability,
}));

import {
  composeMerchantMessage,
  enqueueTranslationBestEffort,
  resetMerchantSupportQueueForTests,
  markMerchantSupportMessageRead,
  readMerchantSupportMessages,
  readMerchantSupportUnreadCount,
  markMerchantSupportMessagesRead,
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
    vi.clearAllMocks();
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
    expect(transaction.$queryRaw.mock.calls[0]?.[0].sql).toContain('FROM "commerce"."Shop"');
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
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
    expect(transaction.$queryRaw.mock.calls[0]?.[0].sql).toContain('FROM "commerce"."Shop"');
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      "translation-dispatch",
      expect.objectContaining({ translationId: result.translationId, schemaVersion: 1 }),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    expect(supportObservability.recordMerchantSupportTranslationDispatchFailure)
      .toHaveBeenCalledWith(result.translationId, expect.any(Error));
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

  it("projects only a tenant-matched initial outreach recovery target", async () => {
    const message = {
      id: "message-1",
      kind: "SYSTEM",
      state: "AVAILABLE",
      originalBody: "A recovery was sent.",
      sourceLanguageTag: "en",
      displayLanguageTag: "en",
      systemCode: "RECOVERY_INITIAL_OUTREACH_SENT",
      systemVersion: "1",
      checkoutRecoveryId: "recovery-1",
      translatedBody: null,
      translationStatus: null,
      createdAt: new Date("2026-10-27T12:00:00.000Z"),
      readAt: null,
    };
    const transaction = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([message])
        .mockResolvedValueOnce([{ count: 1n, unread: 0n }]),
    };
    const database = { $transaction: vi.fn(async (callback) => callback(transaction)) };

    const page = await readMerchantSupportMessages({ shopId: "shop-1", database });
    const historySql = transaction.$queryRaw.mock.calls[0]?.[0].sql as string;

    expect(page.items[0]?.checkoutRecoveryId).toBe("recovery-1");
    expect(historySql).toContain('LEFT JOIN "commerce"."CheckoutRecovery" r');
    expect(historySql).toContain('ON r."id" = m."checkoutRecoveryId" AND r."shopId" = t."shopId"');
    expect(historySql).toContain("m.\"kind\" = 'SYSTEM' AND m.\"state\" = 'AVAILABLE'");
    expect(historySql).toContain("m.\"systemCode\" = 'RECOVERY_INITIAL_OUTREACH_SENT' AND m.\"systemVersion\" = '1'");
    expect(historySql).toContain('r."id" IS NOT NULL THEN r."id" ELSE NULL END AS "checkoutRecoveryId"');
    expect(transaction.$queryRaw.mock.calls[1]?.[0].sql).not.toContain('"commerce"."CheckoutRecovery"');
  });

  it("logs and propagates Support database read failures without returning a page", async () => {
    const failure = new Error("database unavailable");
    const database = { $transaction: vi.fn().mockRejectedValue(failure) };

    await expect(readMerchantSupportMessages({ shopId: "shop-1", database })).rejects.toBe(failure);
    expect(supportObservability.recordMerchantSupportReadFailure).toHaveBeenCalledWith("shop-1", failure, "read_support_page");
  });

  it("returns true only for tenant-owned AVAILABLE outbound messages", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const queryRaw = vi.fn().mockResolvedValue([{ marked: true }]);
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
    expect(queryRaw.mock.calls[0][0].sql).toContain('e."readAt" IS NULL');
    expect(executeRaw).not.toHaveBeenCalled();

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

describe("support bounded repository operations", () => {
  it("reads a badge with one raw SELECT and no transaction/body projection", async () => {
    const database = { $queryRaw: vi.fn().mockResolvedValue([{ unread: 9n }]), $transaction: vi.fn() };
    expect(await readMerchantSupportUnreadCount({ shopId: "shop-1", database })).toBe(9);
    expect(database.$queryRaw).toHaveBeenCalledOnce(); expect(database.$transaction).not.toHaveBeenCalled();
    const query = database.$queryRaw.mock.calls[0][0];
    expect(query.sql).not.toContain("originalBody"); expect(query.values).toEqual(["shop-1"]);
  });
  it.each([[], Array.from({length: 51}, (_, i) => String(i)), ["same", "same"], [""], ["x".repeat(192)]].map(messageIds => ({messageIds})))("rejects invalid direct batches before DB access: %j", async ({messageIds}) => {
    const database = { $transaction: vi.fn() };
    expect(await markMerchantSupportMessagesRead({ shopId: "shop-1", messageIds, database })).toEqual({ marked: false });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
  it("uses one gated locking statement for fifty IDs", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ marked: true }]), $executeRaw: vi.fn() };
    const database = { $transaction: vi.fn(async callback => callback(tx)) };
    const messageIds = Array.from({length: 50}, (_, i) => `message-${i}`);
    expect(await markMerchantSupportMessagesRead({ shopId: "shop-1", messageIds, database })).toEqual({ marked: true });
    expect(tx.$queryRaw).toHaveBeenCalledOnce(); expect(tx.$executeRaw).not.toHaveBeenCalled();
    const query = tx.$queryRaw.mock.calls[0][0];
    expect(query.sql).toContain('ORDER BY m."id" ASC FOR UPDATE OF m');
    expect(query.values).toContain(50); expect(query.values).toContain("message-49");
  });
});

it("catches queue acquisition failures after durable composition", async () => {
  vi.stubEnv("REDIS_URL", "redis://fixture.invalid");
  queuePorts.construct.mockImplementationOnce(() => { throw new Error("original constructor failure"); });
  const {database} = databaseFor("fr");
  try {
    const result = await composeMerchantMessage({shopId: "shop-1", body: "Bonjour", database});
    expect(result.translationId).toBeTruthy();
    expect(supportObservability.recordMerchantSupportTranslationDispatchFailure).toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); await resetMerchantSupportQueueForTests(); }
});
it("records missing optional configuration only when a translation is dispatched", async () => {
  vi.stubEnv("REDIS_URL", "");
  try { await enqueueTranslationBestEffort("translation-1");
    expect(supportObservability.recordMerchantSupportTranslationDispatchFailure).toHaveBeenCalledWith("translation-1", expect.any(Error));
  } finally { vi.unstubAllEnvs(); }
});

it("catches old queue close failures after commit", async () => {
  queuePorts.close.mockResolvedValue(undefined); queuePorts.add.mockResolvedValue(undefined);
  vi.stubEnv("REDIS_URL", "redis://fixture-one.invalid");
  try {
    await enqueueTranslationBestEffort("translation-1");
    vi.stubEnv("REDIS_URL", "redis://fixture-two.invalid");
    const error = new Error("original close failure"); queuePorts.close.mockRejectedValueOnce(error);
    const {database} = databaseFor("fr");
    const result = await composeMerchantMessage({shopId: "shop-1", body: "Bonjour", database});
    expect(result.translationId).toBeTruthy();
    expect(supportObservability.recordMerchantSupportTranslationDispatchFailure).toHaveBeenCalledWith(result.translationId, error);
  } finally { vi.unstubAllEnvs(); queuePorts.close.mockResolvedValue(undefined); await resetMerchantSupportQueueForTests(); }
});
