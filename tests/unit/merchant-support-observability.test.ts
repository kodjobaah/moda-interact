import { beforeEach, describe, expect, it, vi } from "vitest";
const queuePorts = vi.hoisted(() => ({ construct: vi.fn(), close: vi.fn(), add: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class { constructor() { queuePorts.construct(); } close = queuePorts.close; add = queuePorts.add; } }));
const output = vi.hoisted(() => ({ records: [] as unknown[], broken: false }));
vi.mock("@modainteract/moda-interact-shared/logging", async importOriginal => {
  const actual = await importOriginal<typeof import("@modainteract/moda-interact-shared/logging")>();
  return { ...actual, createLogger: (options: Parameters<typeof actual.createLogger>[0]) => actual.createLogger({ ...options, sink: record => {
    if (output.broken) throw new Error("sink failed"); output.records.push(JSON.parse(JSON.stringify(record)));
  } }) };
});
import { recordMerchantSupportReadFailure, recordMerchantSupportSendFailure, recordMerchantSupportTranslationDispatchFailure, recordMerchantSupportAcknowledgementFailure } from "../../app/services/merchant-support/merchant-support-observability.server";
import { markMerchantSupportMessagesRead, readMerchantSupportMessages, readMerchantSupportUnreadCount, composeMerchantMessage, resetMerchantSupportQueueForTests, enqueueTranslationBestEffort } from "../../app/services/merchant-support/merchant-support.service";
const failure = () => Object.assign(new Error("original database marker email=private@example.test redis://secret-host", { cause: new Error("original cause access_token=private-token") }), { code: "P2010" });
beforeEach(() => { output.records.length = 0; output.broken = false; });
describe("support real Shared output", () => {
  it.each([recordMerchantSupportReadFailure, recordMerchantSupportSendFailure, recordMerchantSupportAcknowledgementFailure, recordMerchantSupportTranslationDispatchFailure])("preserves source fields and redacts secrets", record => {
    const error = failure(); record("shop-1", error);
    const json = JSON.stringify(output.records);
    for (const marker of ["original database marker", "original cause", "P2010"]) expect(json).toContain(marker);
    for (const secret of ["private@example.test", "private-token", "secret-host"]) expect(json).not.toContain(secret);
    expect(json).toContain('"redactionApplied":true'); expect(error.cause).toBeInstanceOf(Error);
  });
  it.each(["badge", "page", "aggregate", "ack"])("owns %s failures once and preserves the original rejection with broken sink too", async operation => {
    for (const broken of [false, true]) {
      output.records.length = 0; output.broken = broken; const error = failure();
      const tx = { $queryRaw: vi.fn().mockRejectedValue(error), $executeRaw: vi.fn() };
      if (operation === "aggregate") tx.$queryRaw.mockResolvedValueOnce([]);
      const database = { $transaction: vi.fn(async callback => callback(tx)) };
      const run = operation === "badge" ? readMerchantSupportUnreadCount({ shopId: "shop-1", database })
        : operation === "ack" ? markMerchantSupportMessagesRead({ shopId: "shop-1", messageIds: ["one"], database })
        : readMerchantSupportMessages({ shopId: "shop-1", database });
      await expect(run).rejects.toBe(error);
      expect(output.records).toHaveLength(broken ? 0 : 1);
    }
  });
  it("retains successful durable composition on a queue add failure and a throwing sink", async () => {
    for (const broken of [false, true]) {
      output.records.length = 0; output.broken = broken;
      const tx = { $queryRaw: vi.fn().mockResolvedValueOnce([{defaultLanguageTag: "fr"}]).mockResolvedValueOnce([{id: "thread"}]), $executeRaw: vi.fn().mockResolvedValue(1) };
      const result = await composeMerchantMessage({ shopId: "shop-1", body: "Bonjour", database: { $transaction: async callback => callback(tx) }, queue: { add: vi.fn().mockRejectedValue(failure()) } });
      expect(result.translationId).toBeTruthy(); expect(output.records).toHaveLength(broken ? 0 : 1);
    }
  });
});

it.each(["constructor", "close", "add"])("emits the actual safe postcommit %s failure once", async stage => {
  vi.stubEnv("REDIS_URL", "redis://fixture-one.invalid");
  queuePorts.close.mockResolvedValue(undefined); queuePorts.add.mockResolvedValue(undefined);
  const error = failure();
  try {
    if (stage === "close") {
      await enqueueTranslationBestEffort("previous"); vi.stubEnv("REDIS_URL", "redis://fixture-two.invalid");
      queuePorts.close.mockRejectedValueOnce(error);
    } else if (stage === "constructor") queuePorts.construct.mockImplementationOnce(() => { throw error; });
    else queuePorts.add.mockRejectedValueOnce(error);
    const tx = { $queryRaw: vi.fn().mockResolvedValueOnce([{defaultLanguageTag: "fr"}]).mockResolvedValueOnce([{id: "thread"}]), $executeRaw: vi.fn().mockResolvedValue(1) };
    const result = await composeMerchantMessage({shopId: "shop-1", body: "Bonjour", database: {$transaction: async callback => callback(tx)}});
    expect(result.translationId).toBeTruthy(); expect(output.records).toHaveLength(1);
    const json = JSON.stringify(output.records); expect(json).toContain("original database marker"); expect(json).toContain("original cause");
    expect(json).not.toContain("private-token"); expect(json).not.toContain("secret-host");
  } finally { queuePorts.close.mockResolvedValue(undefined); await resetMerchantSupportQueueForTests(); vi.unstubAllEnvs(); }
});
