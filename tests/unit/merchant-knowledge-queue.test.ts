import {afterEach, beforeEach, expect, it, vi} from "vitest";
const mocks = vi.hoisted(() => ({construct: vi.fn(), add: vi.fn(), close: vi.fn(), on: vi.fn(), records: [] as unknown[], broken: false}));
vi.mock("bullmq", () => ({Queue: class {constructor() {mocks.construct();} add = mocks.add; close = mocks.close; on = mocks.on;}}));
vi.mock("@modainteract/moda-interact-shared/logging", async original => {
 const real = await original<typeof import("@modainteract/moda-interact-shared/logging")>();
 return {...real, createLogger: (options: Parameters<typeof real.createLogger>[0]) => real.createLogger({...options, sink: record => {if (mocks.broken) throw new Error("sink"); mocks.records.push(JSON.parse(JSON.stringify(record)));}})};
});
import {enqueueMerchantKnowledgeRevisionBestEffort, resetMerchantKnowledgeQueueForTests} from "../../app/services/merchant-knowledge/merchant-knowledge-queue.server";
const input = {shopId: "shop-1", sourceRevisionId: "revision-1", generation: 1, requestedAt: new Date("2026-10-01T12:00:00Z")};
beforeEach(() => {vi.resetAllMocks(); mocks.records.length = 0; mocks.broken = false; mocks.add.mockResolvedValue({}); mocks.close.mockResolvedValue(undefined); vi.stubEnv("REDIS_URL", "redis://fixture-one.invalid");});
afterEach(async () => {mocks.close.mockResolvedValue(undefined); await resetMerchantKnowledgeQueueForTests(); vi.unstubAllEnvs();});
it.each(["construct", "close", "add", "missing"])("records original safe %s failure once, preserving best-effort false", async stage => {
 const cause = Object.assign(new Error("original queue marker redis://private.example", {cause: new Error("original causal marker access_token=private-token")}), {code: "ECONNREFUSED"});
 if (stage === "construct") mocks.construct.mockImplementationOnce(() => {throw cause;});
 if (stage === "close") {await enqueueMerchantKnowledgeRevisionBestEffort(input); vi.stubEnv("REDIS_URL", "redis://fixture-two.invalid"); mocks.close.mockRejectedValueOnce(cause);}
 if (stage === "add") mocks.add.mockRejectedValueOnce(cause);
 if (stage === "missing") vi.stubEnv("REDIS_URL", "");
 expect(await enqueueMerchantKnowledgeRevisionBestEffort(input)).toBe(false); expect(mocks.records).toHaveLength(1);
 const json = JSON.stringify(mocks.records);
 if (stage !== "missing") {for (const marker of ["original queue marker", "original causal marker", "ECONNREFUSED", "transport"]) expect(json).toContain(marker); expect(json).not.toContain("databaseCode");}
 for (const value of ["private.example", "private-token"]) expect(json).not.toContain(value);
});
it("contains publication failure even if the actual Shared sink throws", async () => {
 mocks.broken = true; mocks.add.mockRejectedValue(new Error("safe queue failure")); expect(await enqueueMerchantKnowledgeRevisionBestEffort(input)).toBe(false);
});
it("reports successful publication without diagnostics", async () => {
 expect(await enqueueMerchantKnowledgeRevisionBestEffort(input)).toBe(true); expect(mocks.add).toHaveBeenCalledOnce(); expect(mocks.records).toEqual([]);
});

it("owns an idle queue emitter error through real Shared output", async () => {
  expect(await enqueueMerchantKnowledgeRevisionBestEffort(input)).toBe(true); mocks.records.length = 0;
  const error = Object.assign(new Error("idle queue source marker", {cause: new Error("idle queue cause")}), {code: "ECONNREFUSED"});
  const listener = mocks.on.mock.calls.at(-1)![1] as (error: Error) => void;
  listener(error); const json = JSON.stringify(mocks.records);
  expect(mocks.records).toHaveLength(1); for (const marker of ["idle queue source marker", "idle queue cause", "ECONNREFUSED", "transport"]) expect(json).toContain(marker);
  mocks.broken = true; expect(() => listener(new Error("sink isolated"))).not.toThrow();
});
