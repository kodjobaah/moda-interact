import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../app/db.server", () => ({ default: {} }));

import {
  createMerchantKnowledgeUploadIntent,
  finalizeMerchantKnowledgeUpload,
  reprocessMerchantKnowledgeUpload,
} from "../../app/services/merchant-knowledge/upload.server";
import type { MerchantKnowledgeR2Client } from "../../app/services/merchant-knowledge/r2-client.server";
import type { MerchantKnowledgeR2Config } from "../../app/services/merchant-knowledge/r2-config.server";

const execFileAsync = promisify(execFile);
const integrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === "1";
const describeWithDatabase = integrationEnabled ? describe : describe.skip;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const prismaExecutable = resolve(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
const fixturePrefix = `arch023-shopify005-${randomUUID()}`;
const configuration = {
  schemaVersion: 1,
  maxKnowledgeSources: 3,
  maxContentUnitsPerSource: 1000,
  allowedSourceTypes: [{ purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV" }],
};
const r2Config: MerchantKnowledgeR2Config = {
  endpoint: "https://account.r2.example",
  bucket: "merchant-knowledge",
  accessKeyId: "test-access",
  secretAccessKey: "test-secret",
  maxUploadBytes: 1_000_000,
  region: "auto",
};

let postgres: StartedPostgreSqlContainer | undefined;
let database: PrismaClient | undefined;
let featureId: string;

async function deployMigrations(databaseUrl: string): Promise<void> {
  await execFileAsync(prismaExecutable, ["migrate", "deploy", "--schema", "database/prisma/schema.prisma"], {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function db(): PrismaClient {
  if (!database) throw new Error("Disposable PostgreSQL client is unavailable");
  return database;
}

function makeR2(overrides: Partial<MerchantKnowledgeR2Client> = {}) {
  return {
    signPut: vi.fn().mockResolvedValue("https://r2.example/signed-put"),
    headObject: vi.fn().mockResolvedValue({ contentLength: 128, contentType: "text/csv" }),
    ...overrides,
  } satisfies MerchantKnowledgeR2Client;
}

function makeQueue(add = vi.fn().mockResolvedValue(undefined)) {
  return { add } as unknown as NonNullable<Parameters<typeof finalizeMerchantKnowledgeUpload>[0]["queue"]>;
}

async function createShop(): Promise<string> {
  const shopId = `${fixturePrefix}-${randomUUID()}`;
  await db().shop.create({ data: { id: shopId, domain: `${shopId}.myshopify.com` } });
  await db().shopSettings.create({ data: { shopId, defaultLanguageTag: "fr" } });
  const plan = await db().billingPlan.create({
    data: {
      shopifyPlanHandle: `${fixturePrefix}-${randomUUID()}`,
      name: "Merchant Knowledge upload plan",
      kind: "FREE",
      features: { create: { featureId, enabled: true, configuration: configuration as Prisma.InputJsonValue } },
    },
  });
  await db().subscription.create({ data: { shopId, planId: plan.id, status: "ACTIVE" } });
  return shopId;
}

async function setEnabled(shopId: string, enabled: boolean): Promise<void> {
  await db().shopFeaturePreference.upsert({
    where: { shopId_featureId: { shopId, featureId } },
    create: { shopId, featureId, enabled },
    update: { enabled },
  });
}

async function intent(shopId: string, r2 = makeR2(), now = new Date("2026-10-01T12:00:00.000Z")) {
  return createMerchantKnowledgeUploadIntent({
    shopId,
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: "catalog.csv",
    contentType: "text/csv",
    sizeBytes: 128,
    database: db(),
    r2,
    config: r2Config,
    now: () => now,
  });
}

async function finalize(shopId: string, assetId: string, options: {
  sourceId?: string;
  r2?: MerchantKnowledgeR2Client;
  queue?: NonNullable<Parameters<typeof finalizeMerchantKnowledgeUpload>[0]["queue"]>;
  sha256?: string;
  now?: Date;
} = {}) {
  return finalizeMerchantKnowledgeUpload({
    shopId,
    assetId,
    purposeKey: "PRODUCT_INFORMATION",
    name: "Product catalog",
    languageTag: "en",
    sizeBytes: 128,
    sha256: options.sha256 ?? "a".repeat(64),
    contentType: "text/csv",
    sourceId: options.sourceId,
    database: db(),
    r2: options.r2 ?? makeR2(),
    config: r2Config,
    queue: options.queue,
    now: () => options.now ?? new Date("2026-10-01T12:01:00.000Z"),
  });
}

describeWithDatabase("Merchant Knowledge uploaded source lifecycle PostgreSQL transactions", () => {
  beforeAll(async () => {
    try {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      postgres = await new PostgreSqlContainer("pgvector/pgvector:pg17")
        .withDatabase(`arch023_s005_${suffix}`)
        .withUsername(`arch023_s005_${suffix}`)
        .withPassword(`test_${randomUUID().replaceAll("-", "")}`)
        .start();
      await deployMigrations(postgres.getConnectionUri());
      database = new PrismaClient({ datasourceUrl: postgres.getConnectionUri() });
      await database.$connect();
      const feature = await database.feature.findUnique({ where: { key: "merchant_knowledge" } })
        ?? await database.feature.create({
          data: {
            key: "merchant_knowledge",
            displayName: "Merchant Knowledge",
            activationMode: "MERCHANT_OPT_IN",
            systemRequired: false,
          },
        });
      featureId = feature.id;
    } catch (error) {
      await database?.$disconnect();
      await postgres?.stop();
      postgres = undefined;
      throw error;
    }
  }, 240_000);

  afterAll(async () => {
    try {
      await database?.$disconnect();
    } finally {
      await postgres?.stop();
      postgres = undefined;
    }
  }, 60_000);

  it("creates a server-keyed ten-minute intent without consuming a source slot", async () => {
    const shopId = await createShop();
    const now = new Date("2026-10-01T12:00:00.000Z");
    const r2 = makeR2();
    const result = await intent(shopId, r2, now);
    const asset = await db().merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: result.assetId } });

    expect(result).toEqual({
      assetId: expect.any(String),
      uploadUrl: "https://r2.example/signed-put",
      expiresAt: "2026-10-01T12:10:00.000Z",
      requiredHeaders: { "Content-Type": "text/csv", "If-None-Match": "*" },
      maxUploadBytes: 1_000_000,
    });
    expect(asset).toMatchObject({
      shopId,
      status: "PENDING_UPLOAD",
      objectKey: `merchant-knowledge/${shopId}/${asset.id}/source.csv`,
      originalFileName: "catalog.csv",
      contentType: null,
      sizeBytes: null,
      sha256: null,
    });
    expect(await db().merchantKnowledgeSource.count({ where: { shopId } })).toBe(0);
    expect(r2.signPut).toHaveBeenCalledWith({
      bucket: "merchant-knowledge",
      key: asset.objectKey,
      contentType: "text/csv",
      ifNoneMatch: "*",
      expiresIn: 600,
    });
  });

  it("rejects cross-shop finalization before HeadObject and leaves the pending asset untouched", async () => {
    const owner = await createShop();
    const stranger = await createShop();
    const upload = await intent(owner);
    const r2 = makeR2();

    await expect(finalize(stranger, upload.assetId, { r2 })).rejects.toMatchObject({ code: "DENIED" });
    expect(r2.headObject).not.toHaveBeenCalled();
    expect(await db().merchantKnowledgeSource.count({ where: { shopId: owner } })).toBe(0);
    expect(await db().merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: upload.assetId } })).toMatchObject({ status: "PENDING_UPLOAD" });
  });

  it("creates, replaces immutably, then reprocesses the same available asset", async () => {
    const shopId = await createShop();
    await setEnabled(shopId, true);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const queue = makeQueue(enqueue);
    const firstIntent = await intent(shopId);
    const first = await finalize(shopId, firstIntent.assetId, { queue });
    const firstRevision = await db().merchantKnowledgeSourceRevision.findFirstOrThrow({
      where: { sourceId: first.sourceId },
    });
    await db().merchantKnowledgeSourceRevision.update({
      where: { id: firstRevision.id },
      data: { status: "ACTIVE", contentUnits: 0, contentHash: "a".repeat(64) },
    });

    const replacementIntent = await intent(shopId);
    await finalize(shopId, replacementIntent.assetId, { sourceId: first.sourceId, queue });
    const replacementRevision = await db().merchantKnowledgeSourceRevision.findFirstOrThrow({
      where: { sourceId: first.sourceId, generation: 2 },
    });
    const oldAsset = await db().merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: firstIntent.assetId } });
    const newAsset = await db().merchantKnowledgeUploadedAsset.findUniqueOrThrow({ where: { id: replacementIntent.assetId } });

    expect(replacementRevision).toMatchObject({ reason: "FILE_REPLACE", status: "PENDING", uploadedAssetId: replacementIntent.assetId, requestedUrl: null });
    expect(await db().merchantKnowledgeSourceRevision.findUniqueOrThrow({ where: { id: firstRevision.id } })).toMatchObject({ status: "ACTIVE", uploadedAssetId: firstIntent.assetId });
    expect(oldAsset).toMatchObject({ status: "AVAILABLE" });
    expect(newAsset).toMatchObject({ status: "AVAILABLE" });

    await reprocessMerchantKnowledgeUpload({ shopId, sourceId: first.sourceId, database: db(), queue });
    const reprocessRevision = await db().merchantKnowledgeSourceRevision.findFirstOrThrow({
      where: { sourceId: first.sourceId, generation: 3 },
    });
    expect(reprocessRevision).toMatchObject({ reason: "REPROCESS", status: "PENDING", uploadedAssetId: replacementIntent.assetId, requestedUrl: null });
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("leaves durable pending work when Merchant Knowledge is OFF or queue publication fails", async () => {
    const shopId = await createShop();
    const offQueue = vi.fn().mockResolvedValue(undefined);
    const firstIntent = await intent(shopId);
    const first = await finalize(shopId, firstIntent.assetId, { queue: makeQueue(offQueue) });
    expect(offQueue).not.toHaveBeenCalled();
    expect(await db().merchantKnowledgeSourceRevision.findFirstOrThrow({ where: { sourceId: first.sourceId } })).toMatchObject({ status: "PENDING" });

    await setEnabled(shopId, true);
    const failingQueue = vi.fn().mockRejectedValue(new Error("Redis unavailable"));
    const secondIntent = await intent(shopId);
    const second = await finalize(shopId, secondIntent.assetId, { queue: makeQueue(failingQueue) });
    const revision = await db().merchantKnowledgeSourceRevision.findFirstOrThrow({ where: { sourceId: second.sourceId } });
    expect(failingQueue).toHaveBeenCalledOnce();
    expect(revision).toMatchObject({ status: "PENDING", uploadedAssetId: secondIntent.assetId });
  });
});
