import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMerchantKnowledgeR2Client } from "../../app/services/merchant-knowledge/r2-client.server";
import { r2ClientConfigFromSnapshot } from "../../app/services/merchant-knowledge/r2-config.server";

const serviceMocks = vi.hoisted(() => ({
  database: { $transaction: vi.fn() },
  transaction: {
    merchantKnowledgeDataFormat: { findUniqueOrThrow: vi.fn() },
    merchantKnowledgeUploadedAsset: { create: vi.fn(), findUnique: vi.fn() },
  },
  lockShop: vi.fn(),
  activation: vi.fn(),
  requireAllowedPair: vi.fn(),
  entitlement: vi.fn(),
  signPut: vi.fn(),
  headObject: vi.fn(),
  requireR2: vi.fn(),
}));

vi.mock("../../app/db.server", () => ({ default: serviceMocks.database }));
vi.mock("../../app/services/platform-configuration/composition.server", () => ({
  createDefaultShopifyPlatformConfigurationService: () => ({
    requireMerchantKnowledgeR2Configuration: serviceMocks.requireR2,
  }),
}));
vi.mock("../../app/services/merchant-knowledge/merchant-knowledge-entitlement.server", () => ({
  loadCurrentMerchantKnowledgeEntitlement: serviceMocks.entitlement,
}));
vi.mock("../../app/services/merchant-knowledge/merchant-knowledge.server", () => ({
  createMerchantKnowledgeRevision: vi.fn(),
  enqueueMerchantKnowledgeRevisionIfEnabled: vi.fn(),
  lockMerchantKnowledgeShop: serviceMocks.lockShop,
  MerchantKnowledgeError: class MerchantKnowledgeError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  readMerchantKnowledgeActivation: serviceMocks.activation,
  requireAllowedPair: serviceMocks.requireAllowedPair,
  requireCurrentlyPlanEntitledSource: vi.fn(),
}));

import {
  createMerchantKnowledgeUploadIntent,
  finalizeMerchantKnowledgeUpload,
} from "../../app/services/merchant-knowledge/upload.server";

it("adapts one validated six-field sealed policy snapshot for the R2 client", () => {
  const snapshot = Object.freeze({
    version: 8,
    endpoint: "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com",
    bucket: "merchant-knowledge",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    maxUploadBytes: 10_485_760,
    maxXlsxUncompressedBytes: 20_971_520,
  });
  const client = r2ClientConfigFromSnapshot(snapshot);
  expect(client).toEqual({
    endpoint: snapshot.endpoint,
    bucket: snapshot.bucket,
    accessKeyId: snapshot.accessKeyId,
    secretAccessKey: snapshot.secretAccessKey,
    maxUploadBytes: snapshot.maxUploadBytes,
    maxXlsxUncompressedBytes: snapshot.maxXlsxUncompressedBytes,
    region: "auto",
  });
  expect(Object.isFrozen(client)).toBe(true);
  expect(client).not.toHaveProperty("version");
});

const testConfig = {
  endpoint: "https://account.r2.example",
  bucket: "merchant-knowledge",
  accessKeyId: "access",
  secretAccessKey: "secret",
  maxUploadBytes: 1_000,
  maxXlsxUncompressedBytes: 2_000,
  region: "auto" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
  serviceMocks.database.$transaction.mockImplementation((callback) => callback(serviceMocks.transaction));
  serviceMocks.entitlement.mockResolvedValue({
    kind: "entitled",
    configuration: {
      schemaVersion: 1,
      maxKnowledgeSources: 1,
      maxContentUnitsPerSource: 1000,
      allowedSourceTypes: [{ purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV" }],
    },
  });
  serviceMocks.requireAllowedPair.mockResolvedValue({ purposeId: "purpose-product", dataFormatId: "format-csv" });
  serviceMocks.transaction.merchantKnowledgeDataFormat.findUniqueOrThrow.mockResolvedValue({
    id: "format-csv",
    key: "CSV",
    inputKind: "UPLOAD",
    canonicalExtension: ".csv",
    acceptedContentTypes: ["text/csv", "application/csv"],
    active: true,
  });
  serviceMocks.transaction.merchantKnowledgeUploadedAsset.create.mockResolvedValue({});
  serviceMocks.signPut.mockResolvedValue("https://r2.example/signed-put");
  serviceMocks.headObject.mockResolvedValue({ contentLength: 32, contentType: "text/csv" });
  serviceMocks.requireR2.mockResolvedValue({ version: 1, ...testConfig });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("persists a server-generated object key before signing one 600-second PUT", async () => {
  const result = await createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
    shopDomain: "eugene-bdx7mzhn.myshopify.com",
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: " catalog.csv ",
    contentType: "text/csv",
    sizeBytes: 32,
    database: serviceMocks.database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
    config: testConfig,
    now: () => new Date("2026-10-01T12:00:00.000Z"),
  });
  const created = serviceMocks.transaction.merchantKnowledgeUploadedAsset.create.mock.calls[0]?.[0];

  expect(created.data).toMatchObject({
    shopId: "shop-1",
    dataFormatId: "format-csv",
    status: "PENDING_UPLOAD",
    objectKey: expect.stringMatching(/^merchant-knowledge\/test\/eugene-bdx7mzhn\.myshopify\.com\/[^/]+\/source\.csv$/),
    originalFileName: "catalog.csv",
    uploadExpiresAt: new Date("2026-10-01T12:10:00.000Z"),
  });
  expect(result).not.toHaveProperty("objectKey");
  expect(result).not.toHaveProperty("credentials");
  expect(serviceMocks.signPut).toHaveBeenCalledWith({
    bucket: "merchant-knowledge",
    key: created.data.objectKey,
    contentType: "text/csv",
    ifNoneMatch: "*",
    expiresIn: 600,
  });
  expect(result).toEqual({
    assetId: expect.any(String),
    uploadUrl: "https://r2.example/signed-put",
    expiresAt: "2026-10-01T12:10:00.000Z",
    requiredHeaders: { "Content-Type": "text/csv", "If-None-Match": "*" },
    maxUploadBytes: 1_000,
  });
});

it("reads one current sealed R2 policy per intent and never mixes environment credentials", async () => {
  vi.stubEnv("MERCHANT_KNOWLEDGE_R2_BUCKET", "stale-legacy-bucket");
  serviceMocks.requireR2.mockResolvedValueOnce({
    version: 9, ...testConfig, bucket: "database-bucket", maxUploadBytes: 1234,
  });
  const result = await createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
    shopDomain: "eugene-bdx7mzhn.myshopify.com",
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: "catalog.csv",
    contentType: "text/csv",
    sizeBytes: 32,
    database: serviceMocks.database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
  });
  expect(serviceMocks.requireR2).toHaveBeenCalledTimes(1);
  expect(serviceMocks.signPut).toHaveBeenCalledWith(expect.objectContaining({ bucket: "database-bucket" }));
  expect(result).toMatchObject({ maxUploadBytes: 1234 });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("access");
});

it("fails closed before creating upload intents when R2 config is revoked", async () => {
  serviceMocks.requireR2.mockRejectedValueOnce(new Error("DISABLED"));
  await expect(createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
    shopDomain: "eugene-bdx7mzhn.myshopify.com",
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: "catalog.csv",
    contentType: "text/csv",
    sizeBytes: 32,
    database: serviceMocks.database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
  })).rejects.toThrow("DISABLED");
  expect(serviceMocks.database.$transaction).not.toHaveBeenCalled();
  expect(serviceMocks.signPut).not.toHaveBeenCalled();
});

it("uses the configured deployment environment as the R2 namespace", async () => {
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "staging");

  await createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
    shopDomain: "eugene-bdx7mzhn.myshopify.com",
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: "catalog.csv",
    contentType: "text/csv",
    sizeBytes: 32,
    database: serviceMocks.database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
    config: testConfig,
  });

  const created = serviceMocks.transaction.merchantKnowledgeUploadedAsset.create.mock.calls[0]?.[0];
  expect(created.data.objectKey).toMatch(
    /^merchant-knowledge\/staging\/eugene-bdx7mzhn\.myshopify\.com\/[^/]+\/source\.csv$/,
  );
});

it("rejects an unsafe deployment environment before allocating an asset", async () => {
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test/production");

  await expect(createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
    shopDomain: "eugene-bdx7mzhn.myshopify.com",
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: "catalog.csv",
    contentType: "text/csv",
    sizeBytes: 32,
    database: serviceMocks.database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
    config: testConfig,
  })).rejects.toThrow("MERCHANT_KNOWLEDGE_DEPLOYMENT_ENVIRONMENT_INVALID");

  expect(serviceMocks.database.$transaction).not.toHaveBeenCalled();
  expect(serviceMocks.signPut).not.toHaveBeenCalled();
});

it("includes the lowercase if-none-match header in the signed PUT request", async () => {
  const client = createMerchantKnowledgeR2Client(testConfig);
  const signedUrl = await client.signPut({
    bucket: "merchant-knowledge",
    key: "merchant-knowledge/shop-1/asset-1/source.csv",
    contentType: "text/csv",
    ifNoneMatch: "*",
    expiresIn: 600,
  });

  const signedHeaders = new URL(signedUrl).searchParams.get("X-Amz-SignedHeaders")?.split(";");
  expect(signedHeaders).toContain("if-none-match");
});

it("rejects a non-canonical Shopify domain before allocating an asset", async () => {
  await expect(createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
    shopDomain: "https://attacker.example/path",
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: "catalog.csv",
    contentType: "text/csv",
    sizeBytes: 32,
    database: serviceMocks.database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
    config: testConfig,
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(serviceMocks.database.$transaction).not.toHaveBeenCalled();
  expect(serviceMocks.signPut).not.toHaveBeenCalled();
});

it("rejects unsupported file pair and size before allocating an asset", async () => {
  await expect(createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
    shopDomain: "eugene-bdx7mzhn.myshopify.com",
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: "catalog.csv",
    contentType: "text/csv",
    sizeBytes: 1001,
    database: serviceMocks.database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
    config: testConfig,
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(serviceMocks.transaction.merchantKnowledgeUploadedAsset.create).not.toHaveBeenCalled();
  expect(serviceMocks.signPut).not.toHaveBeenCalled();
});

it("rejects cross-shop asset finalization before contacting R2", async () => {
  serviceMocks.transaction.merchantKnowledgeUploadedAsset.findUnique.mockResolvedValue({
    id: "asset-1",
    shopId: "owner-shop",
    dataFormatId: "format-csv",
    status: "PENDING_UPLOAD",
    objectKey: "merchant-knowledge/owner-shop/asset-1/source.csv",
    uploadExpiresAt: new Date("2026-10-01T12:10:00.000Z"),
    dataFormat: {
      key: "CSV",
      inputKind: "UPLOAD",
      active: true,
      acceptedContentTypes: ["text/csv"],
    },
  });
  const database = {
    ...serviceMocks.database,
    merchantKnowledgeUploadedAsset: serviceMocks.transaction.merchantKnowledgeUploadedAsset,
  };
  await expect(finalizeMerchantKnowledgeUpload({
    shopId: "attacker-shop",
    assetId: "asset-1",
    purposeKey: "PRODUCT_INFORMATION",
    name: "Catalog",
    languageTag: "en",
    sizeBytes: 32,
    sha256: "a".repeat(64),
    contentType: "text/csv",
    database: database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
    config: testConfig,
    now: () => new Date("2026-10-01T12:01:00.000Z"),
  })).rejects.toMatchObject({ code: "DENIED" });
  expect(serviceMocks.headObject).not.toHaveBeenCalled();
});
it("does not finalise an in-flight object against a newly selected bucket", async () => {
  serviceMocks.requireR2.mockResolvedValueOnce({ version: 4, ...testConfig, bucket: "new-bucket" });
  serviceMocks.transaction.merchantKnowledgeUploadedAsset.findUnique.mockResolvedValue({
    id: "asset-1", shopId: "shop-1", dataFormatId: "format-csv",
    status: "PENDING_UPLOAD", objectKey: "merchant-knowledge/test/shop-1/asset-1/source.csv",
    uploadExpiresAt: new Date("2026-10-01T12:10:00.000Z"),
    dataFormat: { key: "CSV", inputKind: "UPLOAD", active: true, acceptedContentTypes: ["text/csv"] },
  });
  const database = {
    ...serviceMocks.database,
    merchantKnowledgeUploadedAsset: serviceMocks.transaction.merchantKnowledgeUploadedAsset,
  };
  serviceMocks.headObject.mockRejectedValue(new Error("object is only in old bucket"));
  await expect(finalizeMerchantKnowledgeUpload({
    shopId: "shop-1", assetId: "asset-1", purposeKey: "PRODUCT_INFORMATION",
    name: "Catalog", languageTag: "en", sizeBytes: 32,
    sha256: "a".repeat(64), contentType: "text/csv",
    database: database as never,
    r2: { signPut: serviceMocks.signPut, headObject: serviceMocks.headObject },
    now: () => new Date("2026-10-01T12:01:00.000Z"),
  })).rejects.toMatchObject({ code: "UPLOAD_OBJECT_NOT_FOUND" });
  expect(serviceMocks.requireR2).toHaveBeenCalledTimes(1);
  expect(serviceMocks.headObject).toHaveBeenCalledWith({
    bucket: "new-bucket", key: "merchant-knowledge/test/shop-1/asset-1/source.csv",
  });
  expect(serviceMocks.database.$transaction).not.toHaveBeenCalled();
});
