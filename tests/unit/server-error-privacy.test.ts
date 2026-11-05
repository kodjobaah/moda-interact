import "@shopify/shopify-api/adapters/node";
import {shopifyApi, ApiVersion, LogSeverity} from "@shopify/shopify-api";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
const output = vi.hoisted(() => ({records: [] as Array<{event: string; level: string; data: Record<string, unknown>}>, broken: false}));
const ports = vi.hoisted(() => ({read: vi.fn(), construct: vi.fn()}));
vi.mock("@modainteract/moda-interact-shared/logging", async original => {
  const real = await original<typeof import("@modainteract/moda-interact-shared/logging")>();
  return {...real, createLogger: (options: Parameters<typeof real.createLogger>[0]) => real.createLogger({...options, sink: record => {
    if (output.broken) throw new Error("sink failed"); output.records.push(JSON.parse(JSON.stringify(record)));
  }})};
});
vi.mock("@shopify/shopify-app-react-router/adapters/node", () => ({}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({ApiVersion: {July26: "2026-07"}, AppDistribution: {AppStore: "app-store"}, LogSeverity: {Debug: 3}, shopifyApp: ports.construct}));
vi.mock("@shopify/shopify-app-session-storage-prisma", () => ({PrismaSessionStorage: class {}}));
vi.mock("../../app/db.server", () => ({default: {}}));
vi.mock("../../app/services/platform-configuration/composition.server", () => ({createDefaultShopifyPlatformConfigurationService: () => ({requireShopifyOAuthCredentials: ports.read})}));
import {createShopifyPlatformConfigurationService} from "../../app/services/platform-configuration/service.server";
import {platformConfigurationAAD} from "../../app/services/platform-configuration/seal.server";
import {encryptCredential, parseCredentialKeyring} from "@modainteract/moda-interact-shared/security/credentials/node";
import {logBillingBoundaryFailure} from "../../app/services/billing/providers/shopify-billing-diagnostics.server";
const credentials = {version: 1, apiKey: "oauth-public-sentinel", apiSecret: "oauth-private-sentinel"};
const client = {authenticate: {}, unauthenticated: {}, sessionStorage: {}, addDocumentResponseHeaders: vi.fn(), login: vi.fn(), registerWebhooks: vi.fn()};
beforeEach(() => {vi.resetModules(); vi.clearAllMocks(); output.records.length = 0; output.broken = false; ports.read.mockResolvedValue(credentials); ports.construct.mockReturnValue(client);});
afterEach(() => vi.unstubAllEnvs());
describe.each([false, true])("actual SDK/configuration privacy, broken sink=%s", broken => {
  beforeEach(() => {output.broken = broken;});
  it.each([LogSeverity.Error, LogSeverity.Warning, LogSeverity.Info, LogSeverity.Debug])("uses the installed callback for severity %s and omits opaque context", async severity => {
    await import("../../app/shopify.server.js");
    const options = ports.construct.mock.calls[0][0]; expect(options.logger.httpRequests).toBe(false);
    const sdk = shopifyApi({apiKey: credentials.apiKey, apiSecretKey: credentials.apiSecret, apiVersion: ApiVersion.July26,
      scopes: [], hostName: "app.test", isEmbeddedApp: true, logger: options.logger, _logDisabledFutureFlags: false});
    output.records.length = 0;
    await sdk.logger.log(severity, "original SDK source marker oauth-private-sentinel", {package: "sdk-fixture", session: "session-secret", body: "body-secret", headers: "header-secret"});
    const json = JSON.stringify(output.records);
    expect(output.records).toHaveLength(broken ? 0 : 1);
    if (!broken) {expect(json).toContain("original SDK source marker"); expect(output.records[0].data.sdkSeverity).toBe(severity); expect(output.records[0].level).toBe(["error", "warn", "info", "debug"][severity]);}
    for (const secret of [credentials.apiKey, credentials.apiSecret, "session-secret", "body-secret", "header-secret"]) expect(json).not.toContain(secret);
  });
  it("records a bootstrap read rejection and keeps serving closed with the original cause", async () => {
    const source = Object.assign(new Error("original bootstrap marker", {cause: new Error("bootstrap cause marker")}), {code: "P2010"});
    ports.read.mockRejectedValueOnce(source);
    await expect(import("../../app/shopify.server.js")).rejects.toBe(source); expect(ports.construct).not.toHaveBeenCalled();
    expect(output.records).toHaveLength(broken ? 0 : 1);
    if (!broken) for (const marker of ["original bootstrap marker", "bootstrap cause marker", "P2010", "oauth_configuration"]) expect(JSON.stringify(output.records)).toContain(marker);
  });
  it("records an SDK constructor rejection without exposing configured credentials", async () => {
    const source = new Error(`original SDK construction marker ${credentials.apiSecret}`); ports.construct.mockImplementationOnce(() => {throw source;});
    await expect(import("../../app/shopify.server.js")).rejects.toBe(source);
    const json = JSON.stringify(output.records); expect(json).not.toContain(credentials.apiSecret); if (!broken) expect(json).toContain("original SDK construction marker");
  });
  it("logs source DB failure but retains its typed configuration wrapper and exact cause", async () => {
    const source = Object.assign(new Error("original configuration DB marker", {cause: new Error("configuration DB cause")}), {code: "P2021"});
    const service = createShopifyPlatformConfigurationService({environment: "test", database: {platformConfiguration: {findUnique: async () => {throw source;}}}, loadUnsealKeyring: () => {throw new Error("unexpected keyring access");}});
    const caught = await service.requireShopifyOAuthCredentials().catch(error => error);
    expect(caught.code).toBe("DATABASE_UNAVAILABLE"); expect(caught.cause).toBe(source); expect(output.records).toHaveLength(broken ? 0 : 1);
    if (!broken) for (const marker of ["original configuration DB marker", "configuration DB cause", "P2021"]) expect(JSON.stringify(output.records)).toContain(marker);
  });
  it("keeps keyring parser cause while excluding echoed secret material", async () => {
    const source = new SyntaxError(`Unexpected token 's', "private-keyring-sentinel" is not valid JSON`);
    const service = createShopifyPlatformConfigurationService({environment: "test", database: {platformConfiguration: {findUnique: async () => ({environment: "test", key: "shopify.oauth", version: 1, value: {}})}}, loadUnsealKeyring: () => {throw source;}});
    const caught = await service.requireShopifyOAuthCredentials().catch(error => error);
    expect(caught.code).toBe("UNSEAL_FAILED"); expect(caught.cause).toBe(source); expect(JSON.stringify(output.records)).not.toContain("private-keyring-sentinel");
    if (!broken) {expect(JSON.stringify(output.records)).toContain("Unexpected token"); expect(JSON.stringify(output.records)).toContain('"redactionApplied":true');}
  });
});
it("omits opaque SDK prefix JSON honestly instead of logging arbitrary provider output", async () => {
  await import("../../app/shopify.server.js");
  ports.construct.mock.calls[0][0].logger.log(0, '[sdk/ERROR] body: {"opaque-secret":"customer-sentinel"}');
  expect(JSON.stringify(output.records)).not.toContain("customer-sentinel"); expect(JSON.stringify(output.records)).toContain("OPAQUE_SDK_CONTENT_OMITTED");
});
it("central optional diagnostic projection/sensitive values preserve wrapper identity and existing ownership", () => {
  const cause = new Error("source original marker", {cause: new Error("source cause marker")});
  const wrapper = Object.assign(new Error("safe wrapper", {cause}), {code: "INTERNAL_WRAPPER"});
  const projection = Object.assign(new Error("source original marker opaque-known-secret", {cause: cause.cause}), {code: "P2010"});
  logBillingBoundaryFailure({event: "projection.fixture", operation: "fixture", stage: "fixture", error: wrapper, diagnosticError: projection, sensitiveValues: ["opaque-known-secret"], redactionApplied: true});
  logBillingBoundaryFailure({event: "duplicate.fixture", operation: "fixture", stage: "fixture", error: wrapper});
  expect(wrapper.cause).toBe(cause); expect(output.records).toHaveLength(1); const json = JSON.stringify(output.records);
  for (const marker of ["source original marker", "source cause marker", "P2010"]) expect(json).toContain(marker);
  expect(json).not.toContain("opaque-known-secret"); expect(json).not.toContain("INTERNAL_WRAPPER");
});
it("preserves actual decrypted JSON parser cause without emitting plaintext/keyring/ciphertext", async () => {
  const keyring = parseCredentialKeyring(JSON.stringify({root: Buffer.alloc(32, 7).toString("base64")}));
  const envelope = encryptCredential({keyring, activeKeyId: "root", plaintext: "private-config-plaintext-sentinel", aad: platformConfigurationAAD("test", "shopify.oauth", 1)});
  const value = {kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: envelope.keyId,
    nonce: Buffer.from(envelope.nonce).toString("base64"), ciphertext: Buffer.from(envelope.ciphertext).toString("base64"), authTag: Buffer.from(envelope.authTag).toString("base64")};
  const service = createShopifyPlatformConfigurationService({environment: "test", database: {platformConfiguration: {findUnique: async () => ({environment: "test", key: "shopify.oauth", version: 1, value})}}, loadUnsealKeyring: () => keyring});
  const caught = await service.requireShopifyOAuthCredentials().catch(error => error);
  expect(caught.code).toBe("INVALID_VALUE"); expect(caught.cause).toBeInstanceOf(SyntaxError);
  const json = JSON.stringify(output.records); expect(json).not.toContain("private-config-plaintext-sentinel"); expect(json).not.toContain(value.ciphertext);
  expect(json).toContain('"redactionApplied":true'); expect(json).toContain("Unexpected token");
});
