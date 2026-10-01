import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../app/db.server", () => ({ default: {} }));

import {
  createWebPageSource,
  deleteMerchantKnowledgeSource,
  editWebPageSource,
  loadMerchantKnowledge,
  refreshWebPageSource,
  reorderMerchantKnowledgeSources,
} from "../../app/services/merchant-knowledge/merchant-knowledge.server";
import { loadFeaturePreferences, saveFeaturePreferences } from "../../app/services/feature-preferences/feature-preferences.server";

const execFileAsync = promisify(execFile);
const integrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === "1";
const describeWithDatabase = integrationEnabled ? describe : describe.skip;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const prismaExecutable = resolve(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);
const fixturePrefix = `arch023-shopify004-${randomUUID()}`;
const baseConfiguration = {
  schemaVersion: 1,
  maxKnowledgeSources: 4,
  maxContentUnitsPerSource: 1000,
  allowedSourceTypes: [
    { purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" },
    { purposeKey: "PRICING", dataFormatKey: "WEB_PAGE" },
  ],
};

let postgres: StartedPostgreSqlContainer | undefined;
let database: PrismaClient | undefined;
let firstClient: PrismaClient | undefined;
let secondClient: PrismaClient | undefined;
let featureId: string;

async function deployMigrations(databaseUrl: string): Promise<void> {
  await execFileAsync(
    prismaExecutable,
    ["migrate", "deploy", "--schema", "database/prisma/schema.prisma"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

function db(): PrismaClient {
  if (!database) throw new Error("Disposable PostgreSQL client is unavailable");
  return database;
}

function queue(add = vi.fn().mockResolvedValue(undefined)) {
  return { add } as unknown as NonNullable<Parameters<typeof createWebPageSource>[0]["queue"]>;
}

async function createShop(): Promise<string> {
  const shopId = `${fixturePrefix}-${randomUUID()}`;
  await db().shop.create({
    data: { id: shopId, domain: `${shopId}.myshopify.com` },
  });
  await db().shopSettings.create({ data: { shopId, defaultLanguageTag: "fr" } });
  return shopId;
}

async function grantPlan(
  shopId: string,
  configuration: unknown = baseConfiguration,
  status: "ACTIVE" | "TRIALING" = "ACTIVE",
): Promise<void> {
  const plan = await db().billingPlan.create({
    data: {
      shopifyPlanHandle: `${fixturePrefix}-${randomUUID()}`,
      name: "Merchant Knowledge integration plan",
      kind: "FREE",
      features: {
        create: {
          featureId,
          enabled: true,
          configuration: configuration as Prisma.InputJsonValue,
        },
      },
    },
  });
  await db().subscription.create({
    data: { shopId, planId: plan.id, status },
  });
}

async function setMerchantEnabled(shopId: string, enabled: boolean): Promise<void> {
  const snapshot = await loadFeaturePreferences(shopId, db());
  await saveFeaturePreferences(
    shopId,
    [{ featureId, enabled }],
    snapshot.revision,
    db(),
  );
}

async function createPage(
  shopId: string,
  name: string,
  options: {
    purposeKey?: string;
    url?: string;
    queue?: NonNullable<Parameters<typeof createWebPageSource>[0]["queue"]>;
    database?: PrismaClient;
  } = {},
) {
  return createWebPageSource({
    shopId,
    name,
    purposeKey: options.purposeKey ?? "FAQ",
    dataFormatKey: "WEB_PAGE",
    url: options.url ?? `https://example.test/${name.toLowerCase().replaceAll(" ", "-")}`,
    database: options.database ?? db(),
    queue: options.queue,
  });
}

async function insertChunk(revisionId: string): Promise<string> {
  const id = randomUUID();
  await db().$executeRaw(Prisma.sql`
    INSERT INTO commerce."MerchantKnowledgeChunk" (
      "id", "revisionId", "ordinal", "content", "contentUnits", "contentHash",
      "embedding", "embeddingProvider", "embeddingModel", "embeddingDimensions", "embeddingIndexVersion"
    ) VALUES (
      ${id}, ${revisionId}, 0, 'retained reference', 1, ${"a".repeat(64)},
      '[0.1,0.2]'::vector, 'test', 'test-model', 2, 'test-v1'
    )
  `);
  return id;
}

describeWithDatabase("Merchant Knowledge WEB_PAGE lifecycle PostgreSQL transactions", () => {
  beforeAll(async () => {
    try {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      postgres = await new PostgreSqlContainer("pgvector/pgvector:pg17")
        .withDatabase(`arch023_s004_${suffix}`)
        .withUsername(`arch023_s004_${suffix}`)
        .withPassword(`test_${randomUUID().replaceAll("-", "")}`)
        .start();
      const databaseUrl = postgres.getConnectionUri();
      await deployMigrations(databaseUrl);

      database = new PrismaClient({ datasourceUrl: databaseUrl });
      firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
      secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
      await Promise.all([database.$connect(), firstClient.$connect(), secondClient.$connect()]);

      const feature = await database.feature.findUnique({
        where: { key: "merchant_knowledge" },
      }) ?? await database.feature.create({
        data: {
          key: "merchant_knowledge",
          displayName: "Merchant Knowledge",
          activationMode: "MERCHANT_OPT_IN",
          systemRequired: false,
        },
      });
      expect(feature.activationMode).toBe("MERCHANT_OPT_IN");
      featureId = feature.id;
    } catch (error) {
      await Promise.allSettled([
        database?.$disconnect() ?? Promise.resolve(),
        firstClient?.$disconnect() ?? Promise.resolve(),
        secondClient?.$disconnect() ?? Promise.resolve(),
      ]);
      await postgres?.stop();
      postgres = undefined;
      throw error;
    }
  }, 240_000);

  afterAll(async () => {
    try {
      await Promise.allSettled([
        database?.$disconnect() ?? Promise.resolve(),
        firstClient?.$disconnect() ?? Promise.resolve(),
        secondClient?.$disconnect() ?? Promise.resolve(),
      ]);
    } finally {
      await postgres?.stop();
      postgres = undefined;
    }
  }, 60_000);

  it("configures while OFF, queues only while ON, and preserves revisions/chunks when turned OFF", async () => {
    const shopId = await createShop();
    await grantPlan(shopId);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const queueClient = queue(enqueue);

    const first = await createPage(shopId, "FAQ", {
      url: "HTTPS://Example.Test:443/help",
      queue: queueClient,
    });
    expect(enqueue).not.toHaveBeenCalled();
    const source = await db().merchantKnowledgeSource.findUniqueOrThrow({ where: { id: first.sourceId } });
    expect(source).toMatchObject({ shopId, languageTag: "fr", currentGeneration: 1 });
    let revisions = await db().merchantKnowledgeSourceRevision.findMany({
      where: { sourceId: source.id },
      orderBy: { generation: "asc" },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      reason: "CREATE",
      status: "PENDING",
      requestedUrl: "https://example.test/help",
    });
    const retainedChunkId = await insertChunk(revisions[0]!.id);

    await setMerchantEnabled(shopId, true);
    expect(await loadMerchantKnowledge(shopId, db())).toMatchObject({
      planEntitled: true,
      merchantEnabled: true,
      effectiveEnabled: true,
    });
    await editWebPageSource({
      shopId,
      sourceId: source.id,
      name: "FAQ renamed",
      url: "https://example.test/help",
      languageTag: "en",
      database: db(),
      queue: queueClient,
    });
    expect(await db().merchantKnowledgeSourceRevision.count({ where: { sourceId: source.id } })).toBe(1);

    await editWebPageSource({
      shopId,
      sourceId: source.id,
      name: "FAQ renamed",
      url: "https://example.test/help-v2",
      languageTag: "en",
      database: db(),
      queue: queueClient,
    });
    await refreshWebPageSource({ shopId, sourceId: source.id, database: db(), queue: queueClient });
    expect(enqueue).toHaveBeenCalledTimes(2);
    revisions = await db().merchantKnowledgeSourceRevision.findMany({
      where: { sourceId: source.id },
      orderBy: { generation: "asc" },
    });
    expect(revisions.map(({ generation, reason, status }) => ({ generation, reason, status }))).toEqual([
      { generation: 1, reason: "CREATE", status: "PENDING" },
      { generation: 2, reason: "URL_CHANGE", status: "PENDING" },
      { generation: 3, reason: "REFRESH", status: "PENDING" },
    ]);

    const second = await createPage(shopId, "Policies", { queue: queueClient });
    expect(enqueue).toHaveBeenCalledTimes(3);
    await reorderMerchantKnowledgeSources({ shopId, sourceIds: [second.sourceId, source.id], database: db() });
    const beforeOff = {
      sources: await db().merchantKnowledgeSource.findMany({ where: { shopId }, orderBy: { position: "asc" } }),
      revisions: await db().merchantKnowledgeSourceRevision.findMany({
        where: { source: { shopId } },
        orderBy: [{ sourceId: "asc" }, { generation: "asc" }],
      }),
      chunks: await db().$queryRaw<Array<{ id: string; revisionId: string; content: string }>>(Prisma.sql`
        SELECT "id", "revisionId", "content" FROM commerce."MerchantKnowledgeChunk"
        WHERE "revisionId" IN (SELECT id FROM commerce."MerchantKnowledgeSourceRevision" WHERE "sourceId" = ${source.id})
      `),
    };

    await setMerchantEnabled(shopId, false);
    const afterOff = {
      sources: await db().merchantKnowledgeSource.findMany({ where: { shopId }, orderBy: { position: "asc" } }),
      revisions: await db().merchantKnowledgeSourceRevision.findMany({
        where: { source: { shopId } },
        orderBy: [{ sourceId: "asc" }, { generation: "asc" }],
      }),
      chunks: await db().$queryRaw<Array<{ id: string; revisionId: string; content: string }>>(Prisma.sql`
        SELECT "id", "revisionId", "content" FROM commerce."MerchantKnowledgeChunk"
        WHERE "revisionId" IN (SELECT id FROM commerce."MerchantKnowledgeSourceRevision" WHERE "sourceId" = ${source.id})
      `),
    };
    expect(afterOff).toEqual(beforeOff);
    expect(afterOff.chunks).toContainEqual(expect.objectContaining({ id: retainedChunkId, content: "retained reference" }));
    expect((await loadMerchantKnowledge(shopId, db())).effectiveEnabled).toBe(false);

    await refreshWebPageSource({ shopId, sourceId: source.id, database: db(), queue: queueClient });
    expect(enqueue).toHaveBeenCalledTimes(3);

    await editWebPageSource({
      shopId,
      sourceId: source.id,
      name: "FAQ renamed again",
      url: "https://example.test/help-v3",
      languageTag: "en",
      database: db(),
      queue: queueClient,
    });
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(await db().merchantKnowledgeSourceRevision.count({ where: { sourceId: source.id } })).toBe(5);
    await reorderMerchantKnowledgeSources({ shopId, sourceIds: [source.id, second.sourceId], database: db() });
    await deleteMerchantKnowledgeSource({ shopId, sourceId: second.sourceId, database: db() });
    const remaining = await db().merchantKnowledgeSource.findMany({ where: { shopId }, select: { id: true, position: true } });
    expect(remaining).toEqual([{ id: source.id, position: 0 }]);
    expect((await db().merchantKnowledgeSourceRevision.findFirstOrThrow({ where: { sourceId: source.id, generation: 4 } })).reason).toBe("REFRESH");
    expect((await db().merchantKnowledgeSourceRevision.findFirstOrThrow({ where: { sourceId: source.id, generation: 5 } })).status).toBe("PENDING");
  }, 60_000);

  it("leaves committed PENDING work durable when queue publication rejects", async () => {
    const shopId = await createShop();
    await grantPlan(shopId);
    await setMerchantEnabled(shopId, true);
    const add = vi.fn().mockRejectedValue(new Error("Redis unavailable"));

    const created = await createPage(shopId, "Queue failure", { queue: queue(add) });

    expect(add).toHaveBeenCalledOnce();
    await expect(db().merchantKnowledgeSourceRevision.findFirstOrThrow({
      where: { sourceId: created.sourceId },
    })).resolves.toMatchObject({ generation: 1, status: "PENDING" });
  }, 30_000);

  it("rejects missing plans, malformed C2, and unsupported source pairs", async () => {
    const noPlanShop = await createShop();
    await expect(createPage(noPlanShop, "No plan")).rejects.toMatchObject({ code: "DENIED" });
    expect((await loadMerchantKnowledge(noPlanShop, db())).planEntitled).toBe(false);

    const malformedShop = await createShop();
    await grantPlan(malformedShop, { ...baseConfiguration, maxKnowledgeSources: 0 });
    expect((await loadMerchantKnowledge(malformedShop, db())).planEntitled).toBe(false);
    await expect(createPage(malformedShop, "Malformed plan")).rejects.toMatchObject({ code: "DENIED" });

    const restrictedShop = await createShop();
    await grantPlan(restrictedShop, {
      ...baseConfiguration,
      allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }],
    });
    await expect(createPage(restrictedShop, "Pricing", { purposeKey: "PRICING" })).rejects.toMatchObject({ code: "DENIED" });
  }, 30_000);

  it("isolates source mutations and read models by shop", async () => {
    const ownerShop = await createShop();
    const otherShop = await createShop();
    await grantPlan(ownerShop);
    await grantPlan(otherShop);
    const created = await createPage(ownerShop, "Private FAQ");
    const before = await db().merchantKnowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } });

    await expect(editWebPageSource({
      shopId: otherShop,
      sourceId: created.sourceId,
      name: "Stolen",
      url: "https://example.test/stolen",
      languageTag: "en",
      database: db(),
    })).rejects.toMatchObject({ code: "DENIED" });
    await expect(refreshWebPageSource({ shopId: otherShop, sourceId: created.sourceId, database: db() })).rejects.toMatchObject({ code: "DENIED" });
    await expect(deleteMerchantKnowledgeSource({ shopId: otherShop, sourceId: created.sourceId, database: db() })).rejects.toMatchObject({ code: "DENIED" });
    expect((await loadMerchantKnowledge(otherShop, db())).sources).toEqual([]);
    expect(JSON.stringify(await loadMerchantKnowledge(otherShop, db()))).not.toContain("Private FAQ");
    expect(await db().merchantKnowledgeSource.findUniqueOrThrow({ where: { id: created.sourceId } })).toEqual(before);
  }, 30_000);

  it("serializes concurrent creates against the plan cap and concurrent refresh generations", async () => {
    if (!firstClient || !secondClient) throw new Error("Independent PostgreSQL clients are unavailable");
    const capShop = await createShop();
    await grantPlan(capShop, { ...baseConfiguration, maxKnowledgeSources: 1 });
    const createOutcomes = await Promise.allSettled([
      createPage(capShop, "Concurrent one", { database: firstClient }),
      createPage(capShop, "Concurrent two", { database: secondClient }),
    ]);
    expect(createOutcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(await db().merchantKnowledgeSource.count({ where: { shopId: capShop } })).toBe(1);

    const generationShop = await createShop();
    await grantPlan(generationShop);
    const source = await createPage(generationShop, "Generation lock");
    const refreshOutcomes = await Promise.allSettled([
      refreshWebPageSource({ shopId: generationShop, sourceId: source.sourceId, database: firstClient }),
      refreshWebPageSource({ shopId: generationShop, sourceId: source.sourceId, database: secondClient }),
    ]);
    expect(refreshOutcomes.every(({ status }) => status === "fulfilled")).toBe(true);
    const persistedSource = await db().merchantKnowledgeSource.findUniqueOrThrow({ where: { id: source.sourceId } });
    const revisions = await db().merchantKnowledgeSourceRevision.findMany({
      where: { sourceId: source.sourceId },
      orderBy: { generation: "asc" },
      select: { generation: true },
    });
    expect(persistedSource.currentGeneration).toBe(3);
    expect(revisions.map(({ generation }) => generation)).toEqual([1, 2, 3]);
  }, 60_000);
});