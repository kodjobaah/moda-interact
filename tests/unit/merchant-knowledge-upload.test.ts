import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantKnowledgeR2Client } from "../../app/services/merchant-knowledge/r2-client.server";
import {
  loadMerchantKnowledgeR2Config,
  MerchantKnowledgeR2ConfigurationError,
} from "../../app/services/merchant-knowledge/r2-config.server";

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
}));

vi.mock("../../app/db.server", () => ({ default: serviceMocks.database }));
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

const validEnvironment: NodeJS.ProcessEnv = {
  MERCHANT_KNOWLEDGE_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  MERCHANT_KNOWLEDGE_R2_BUCKET: "merchant-knowledge",
  MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID: "access-key",
  MERCHANT_KNOWLEDGE_R2_SECRET_ACCESS_KEY: "secret-key",
  MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES: "10485760",
};

it("loads the exact private R2 contract with the automatic region", () => {
  expect(loadMerchantKnowledgeR2Config(validEnvironment)).toEqual({
    endpoint: "https://account.r2.cloudflarestorage.com/",
    bucket: "merchant-knowledge",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    maxUploadBytes: 10_485_760,
    region: "auto",
  });
});

it.each([
  ["missing endpoint", { ...validEnvironment, MERCHANT_KNOWLEDGE_R2_ENDPOINT: undefined }],
  ["non-HTTPS endpoint", { ...validEnvironment, MERCHANT_KNOWLEDGE_R2_ENDPOINT: "http://r2.example" }],
  ["empty bucket", { ...validEnvironment, MERCHANT_KNOWLEDGE_R2_BUCKET: " " }],
  ["empty credentials", { ...validEnvironment, MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID: " " }],
  ["invalid upload limit", { ...validEnvironment, MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES: "1.5" }],
  ["unsafe upload limit", { ...validEnvironment, MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES: "9007199254740992" }],
])("rejects %s", (_description, environment) => {
  expect(() => loadMerchantKnowledgeR2Config(environment)).toThrow(MerchantKnowledgeR2ConfigurationError);
});

const testConfig = {
  endpoint: "https://account.r2.example",
  bucket: "merchant-knowledge",
  accessKeyId: "access",
  secretAccessKey: "secret",
  maxUploadBytes: 1_000,
  region: "auto" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
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
});

it("persists a server-generated object key before signing one 600-second PUT", async () => {
  const result = await createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
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
    objectKey: expect.stringMatching(/^merchant-knowledge\/shop-1\/[^/]+\/source\.csv$/),
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

it("rejects unsupported file pair and size before allocating an asset", async () => {
  await expect(createMerchantKnowledgeUploadIntent({
    shopId: "shop-1",
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