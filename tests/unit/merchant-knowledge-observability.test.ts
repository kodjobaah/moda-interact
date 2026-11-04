import { beforeEach, expect, it, vi } from "vitest";
const capture = vi.hoisted(() => ({records: [] as unknown[], broken: false}));
vi.mock("@modainteract/moda-interact-shared/logging", async original => {
 const real = await original<typeof import("@modainteract/moda-interact-shared/logging")>();
 return {...real, createLogger: (options: Parameters<typeof real.createLogger>[0]) => real.createLogger({...options, sink: record => {if (capture.broken) throw new Error("sink"); capture.records.push(JSON.parse(JSON.stringify(record)));}})};
});
import { recordMerchantKnowledgeFailure, recordMerchantKnowledgeUploadFailure } from "../../app/services/merchant-knowledge/merchant-knowledge-observability.server";
import { merchantKnowledgeActionFailure } from "../../app/services/merchant-knowledge/merchant-knowledge-http.server";
import { MerchantKnowledgeError } from "../../app/services/merchant-knowledge/merchant-knowledge-error.server";
beforeEach(() => {capture.records.length = 0; capture.broken = false;});
it("preserves original database/cause evidence and strips sensitive text through the installed Shared sink", () => {
 const source = Object.assign(new Error("source marker email=person@example.test redis://secret.example", {cause: new Error("cause marker access_token=private-sentinel")}), {code: "P2021"});
 recordMerchantKnowledgeFailure({shopId: "shop", operation: "read", error: source});
 const json = JSON.stringify(capture.records);
 for (const marker of ["source marker", "cause marker", "P2021", "database"]) expect(json).toContain(marker);
 for (const value of ["person@example.test", "secret.example", "private-sentinel"]) expect(json).not.toContain(value);
 expect(source.cause).toBeInstanceOf(Error);
});
it("marks browser telemetry truthfully without pretending to have source responses", () => {
 recordMerchantKnowledgeUploadFailure({shopId: "shop", stage: "storage_put", errorCode: "STORAGE_HTTP_403", statusCode: 403});
 const json = JSON.stringify(capture.records); expect(json).toContain("client_reported"); expect(json).not.toContain("providerError");
});
it.each([false, true])("safe HTTP responses retain unavailable retryability and business outcomes, brokenSink=%s", async broken => {
 capture.broken = broken;
 const cause = Object.assign(new Error("private internal marker"), {code: "P1001"});
 const operational = merchantKnowledgeActionFailure(cause, {shopId: "shop", operation: "refresh"});
 expect(operational.status).toBe(503); expect(await operational.json()).toEqual({ok: false, error: "UNAVAILABLE", retryable: true});
 for (const [code, status] of [["DENIED", 403], ["INVALID_INPUT", 400], ["CONFLICT", 409]] as const)
  expect(merchantKnowledgeActionFailure(new MerchantKnowledgeError(code), {shopId: "shop", operation: "source"}).status).toBe(status);
});
it("the entitlement source owns actual DB failure evidence before returning retryable unavailable", async () => {
 const {loadCurrentMerchantKnowledgeEntitlement} = await import("../../app/services/merchant-knowledge/merchant-knowledge-entitlement.server");
 const cause = Object.assign(new Error("entitlement original marker", {cause: new Error("original entitlement cause")}), {code: "P1001"});
 const result = await loadCurrentMerchantKnowledgeEntitlement("shop", {subscription: {findUnique: vi.fn().mockRejectedValue(cause)}} as never);
 expect(result).toEqual({kind: "unavailable", retryable: true, cause});
 const json = JSON.stringify(capture.records); for (const marker of ["entitlement original marker", "original entitlement cause", "P1001", "database"]) expect(json).toContain(marker);
 expect(capture.records).toHaveLength(1);
});
it("read-model query failure keeps the original rejection and is diagnosed once even at the HTTP boundary", async () => {
 const {loadMerchantKnowledge} = await import("../../app/services/merchant-knowledge/merchant-knowledge.server");
 const cause = Object.assign(new Error("read source marker", {cause: new Error("read cause marker")}), {code: "P2021"});
 const database = {subscription: {findUnique: vi.fn().mockResolvedValue(null)}, shop: {findUnique: vi.fn().mockResolvedValue({defaultLanguageTag: "en"})}, merchantKnowledgePurposeDataFormat: {findMany: vi.fn().mockRejectedValue(cause)}, merchantKnowledgeSource: {findMany: vi.fn().mockResolvedValue([])}};
 await expect(loadMerchantKnowledge("shop", database as never)).rejects.toBe(cause);
 expect(merchantKnowledgeActionFailure(cause, {shopId: "shop", operation: "read"}).status).toBe(503);
 expect(capture.records).toHaveLength(1); expect(JSON.stringify(capture.records)).toContain("read cause marker");
});

it("does not mislabel a domain configuration reason as a native database code", () => {
 const error = Object.assign(new Error("safe configuration reason", {cause: new TypeError("actual internal cause")}), {code: "DATABASE_UNAVAILABLE"});
 recordMerchantKnowledgeFailure({shopId: "shop", operation: "configuration", error});
 const json = JSON.stringify(capture.records); expect(json).toContain('"sourceCode":"DATABASE_UNAVAILABLE"'); expect(json).toContain('"origin":"internal"'); expect(json).not.toContain("databaseCode");
});
