import { beforeEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({send: vi.fn(), sign: vi.fn(), records: [] as unknown[], broken: false}));
vi.mock("@aws-sdk/client-s3", async original => ({...await original<typeof import("@aws-sdk/client-s3")>(), S3Client: class {send = ports.send;}}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({getSignedUrl: ports.sign}));
vi.mock("@modainteract/moda-interact-shared/logging", async original => {
 const real = await original<typeof import("@modainteract/moda-interact-shared/logging")>();
 return {...real, createLogger: (options: Parameters<typeof real.createLogger>[0]) => real.createLogger({...options, sink: value => {if (ports.broken) throw new Error("sink"); ports.records.push(JSON.parse(JSON.stringify(value)));}})};
});
import { createMerchantKnowledgeR2Client } from "../../app/services/merchant-knowledge/r2-client.server";
import { merchantKnowledgeActionFailure } from "../../app/services/merchant-knowledge/merchant-knowledge-http.server";
beforeEach(() => {ports.records.length = 0; ports.broken = false;});
const config = {endpoint: "https://private-r2.example", bucket: "private-bucket", accessKeyId: "private-access", secretAccessKey: "private-secret", maxUploadBytes: 100, maxXlsxUncompressedBytes: 200, region: "auto" as const};
it.each(["head", "sign"])("preserves actual %s errors/cause/status/request and strips source secrets before real Shared output", async operation => {
 const error = Object.assign(new Error("R2 original marker private-secret private-key person@example.test https://signed.example/?signature=unsafe", {cause: new Error("original cause private-access")}), {name: "AccessDenied", code: "AccessDenied", $metadata: {httpStatusCode: 403, requestId: "safe-request"}});
 ports.send.mockRejectedValue(error); ports.sign.mockRejectedValue(error);
 const client = createMerchantKnowledgeR2Client(config, "shop");
 await expect(operation === "head" ? client.headObject({bucket: config.bucket, key: "private-key"}) : client.signPut({bucket: config.bucket, key: "private-key", contentType: "text/csv", ifNoneMatch: "*", expiresIn: 600})).rejects.toBe(error);
 expect(ports.records).toHaveLength(1); const json = JSON.stringify(ports.records);
 for (const marker of ["R2 original marker", "original cause", "403", "safe-request"]) expect(json).toContain(marker);
 for (const secret of ["private-secret", "private-key", "person@example.test", "signature=unsafe", "private-access"]) expect(json).not.toContain(secret);
 expect(merchantKnowledgeActionFailure(error, {shopId: "shop", operation: "upload"}).status).toBe(503);
 expect(ports.records).toHaveLength(1);
});
it("isolates a throwing Shared sink and retains the exact SDK exception", async () => {
 ports.broken = true; const error = new Error("safe sdk marker"); ports.send.mockRejectedValue(error);
 await expect(createMerchantKnowledgeR2Client(config, "shop").headObject({bucket: config.bucket, key: "private-key"})).rejects.toBe(error);
});

it("retains nested transport evidence and retries safely without fabricating provider response metadata", async () => {
 const cause = Object.assign(new Error("original transport cause"), {code: "ECONNRESET"});
 const source = new TypeError("original fetch failure", {cause}); ports.send.mockRejectedValue(source);
 await expect(createMerchantKnowledgeR2Client(config, "shop").headObject({bucket: config.bucket, key: "private-key"})).rejects.toBe(source);
 const response = merchantKnowledgeActionFailure(source, {shopId: "shop", operation: "upload"});
 expect(await response.json()).toEqual({ok: false, error: "UNAVAILABLE", retryable: true});
 expect(JSON.stringify(ports.records)).toContain("transport"); expect(JSON.stringify(ports.records)).toContain("ECONNRESET"); expect(JSON.stringify(ports.records)).not.toContain("databaseCode"); expect(JSON.stringify(ports.records)).not.toContain("httpStatus");
});

it("does not emit native parser response excerpts and preserves the original SDK exception", async () => {
 const error = new SyntaxError('Unexpected token x in "PRIVATE_RAW_BODY_SENTINEL"'); ports.send.mockRejectedValue(error);
 await expect(createMerchantKnowledgeR2Client(config, "shop").headObject({bucket: config.bucket, key: "private-key"})).rejects.toBe(error);
 const json = JSON.stringify(ports.records); expect(json).not.toContain("PRIVATE_RAW_BODY_SENTINEL"); expect(json).toContain("R2 response parsing failed."); expect(json).toContain('"redactionApplied":true'); expect(json).toContain('"origin":"internal"');
});
