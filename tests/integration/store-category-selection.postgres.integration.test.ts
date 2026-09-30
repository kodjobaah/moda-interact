import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../app/db.server", () => ({ default: {} }));

import { selectPendingStoreCategory } from "../../app/services/store-profile/store-category-selection.server";

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
const fixturePrefix = `arch023-shopify002-${randomUUID()}`;
const canonicalPromptText =
  "Canonical English template instructions\nSecond line.";
const selectionTime = new Date("2026-09-30T12:00:00.000Z");
const activeTime = new Date("2026-09-01T12:00:00.000Z");

let postgres: StartedPostgreSqlContainer | undefined;
let database: PrismaClient | undefined;
let firstClient: PrismaClient | undefined;
let secondClient: PrismaClient | undefined;
let categoryId: string;
let templateId: string;

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

function requireDatabase(): PrismaClient {
  if (!database) throw new Error("Disposable PostgreSQL client is unavailable");
  return database;
}

async function createShop(): Promise<string> {
  const shopId = `${fixturePrefix}-${randomUUID()}`;
  await requireDatabase().shop.create({
    data: { id: shopId, domain: `${shopId}.myshopify.com` },
  });
  return shopId;
}

async function createPublishedShopPrompt(shopId: string) {
  const db = requireDatabase();
  const prompt = await db.commerceAgentPrompt.create({
    data: { scope: "SHOP", shopId },
  });
  const revision = await db.commerceAgentPromptRevision.create({
    data: {
      promptId: prompt.id,
      revisionNumber: 1,
      status: "PUBLISHED",
      promptText: "Existing active prompt instructions",
      publishedAt: activeTime,
    },
  });
  const configuration = await db.commerceAgentConfiguration.create({
    data: {
      environment: "PRODUCTION",
      scope: "SHOP",
      shopId,
      activePromptRevisionId: revision.id,
    },
  });
  return { promptId: prompt.id, activeRevisionId: revision.id, configuration };
}

async function select(
  shopId: string,
  expectedPendingSelectionGeneration: number,
  client: PrismaClient = requireDatabase(),
  now = selectionTime,
) {
  return selectPendingStoreCategory(
    { shopId, categoryId, expectedPendingSelectionGeneration },
    client,
    now,
  );
}

describeWithDatabase("Store Category selection PostgreSQL transaction", () => {
  beforeAll(async () => {
    try {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      postgres = await new PostgreSqlContainer("pgvector/pgvector:pg17")
        .withDatabase(`arch023_s002_${suffix}`)
        .withUsername(`arch023_s002_${suffix}`)
        .withPassword(`test_${randomUUID().replaceAll("-", "")}`)
        .start();
      const databaseUrl = postgres.getConnectionUri();
      await deployMigrations(databaseUrl);

      database = new PrismaClient({ datasourceUrl: databaseUrl });
      firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
      secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
      await Promise.all([
        database.$connect(),
        firstClient.$connect(),
        secondClient.$connect(),
      ]);

      const admin = await database.platformAdmin.create({
        data: {
          email: `${fixturePrefix}@example.test`,
          role: "SUPER_ADMIN",
          active: true,
        },
      });
      const category = await database.commercePromptTemplateCategory.create({
        data: {
          slug: "home-goods",
          displayName: "Home Goods",
          enabled: false,
          displayOrder: 1,
          createdByAdminId: admin.id,
          updatedByAdminId: admin.id,
        },
      });
      const template = await database.commercePromptTemplate.create({
        data: {
          key: `${fixturePrefix.replaceAll("-", "_")}_template`,
          categoryId: category.id,
          displayName: "Home Goods Default",
          promptText: canonicalPromptText,
          enabled: true,
          editVersion: 7,
          createdByAdminId: admin.id,
          updatedByAdminId: admin.id,
        },
      });
      await database.commercePromptTemplateCategory.update({
        where: { id: category.id },
        data: { defaultTemplateId: template.id, enabled: true },
      });
      categoryId = category.id;
      templateId = template.id;
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

  it("creates the initial profile and pending DRAFT with the exact template while preserving active configuration", async () => {
    const db = requireDatabase();
    const shopId = await createShop();
    const beforeConfigurations = await db.commerceAgentConfiguration.findMany({
      where: { shopId, scope: "SHOP" },
      select: {
        id: true,
        activePromptRevisionId: true,
        promptEditVersion: true,
        modelEditVersion: true,
      },
    });

    const result = await select(shopId, 0);

    const profile = await db.commerceShopProfile.findUnique({
      where: { shopId },
    });
    const lineages = await db.commerceAgentPrompt.findMany({
      where: { shopId, scope: "SHOP" },
    });
    const drafts = await db.commerceAgentPromptRevision.findMany({
      where: { prompt: { shopId, scope: "SHOP" }, status: "DRAFT" },
    });
    const afterConfigurations = await db.commerceAgentConfiguration.findMany({
      where: { shopId, scope: "SHOP" },
      select: {
        id: true,
        activePromptRevisionId: true,
        promptEditVersion: true,
        modelEditVersion: true,
      },
    });

    expect(result).toEqual({
      pendingCategoryId: categoryId,
      pendingPromptRevisionId: drafts[0]?.id,
      pendingSelectionGeneration: 1,
    });
    expect(profile).toMatchObject({
      shopId,
      activeCategoryId: null,
      activeCategoryActivatedAt: null,
      pendingCategoryId: categoryId,
      pendingSelectionGeneration: 1,
      pendingSelectedAt: selectionTime,
    });
    expect(lineages).toHaveLength(1);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      promptId: lineages[0]?.id,
      revisionNumber: 1,
      status: "DRAFT",
      promptText: canonicalPromptText,
      sourceTemplateId: templateId,
      sourceTemplateEditVersion: 7,
      editVersion: 1,
    });
    expect(beforeConfigurations).toHaveLength(0);
    expect(afterConfigurations).toEqual(beforeConfigurations);
  }, 30_000);

  it("reuses the pending DRAFT on reselection and leaves active category and prompt unchanged", async () => {
    const db = requireDatabase();
    const shopId = await createShop();
    const { promptId, activeRevisionId } =
      await createPublishedShopPrompt(shopId);
    await db.commerceShopProfile.create({
      data: {
        shopId,
        activeCategoryId: categoryId,
        activeCategoryActivatedAt: activeTime,
      },
    });

    const firstResult = await select(shopId, 0);
    const originalDraft =
      await db.commerceAgentPromptRevision.findUniqueOrThrow({
        where: { id: firstResult.pendingPromptRevisionId },
      });
    await db.commercePromptTemplate.update({
      where: { id: templateId },
      data: {
        promptText: "Updated canonical English instructions",
        editVersion: 8,
      },
    });

    const secondResult = await select(
      shopId,
      1,
      requireDatabase(),
      new Date("2026-09-30T12:05:00.000Z"),
    );
    const profile = await db.commerceShopProfile.findUniqueOrThrow({
      where: { shopId },
    });
    const updatedDraft = await db.commerceAgentPromptRevision.findUniqueOrThrow(
      {
        where: { id: originalDraft.id },
      },
    );
    const lineages = await db.commerceAgentPrompt.findMany({
      where: { shopId, scope: "SHOP" },
    });
    const configurations = await db.commerceAgentConfiguration.findMany({
      where: { shopId, scope: "SHOP" },
    });

    expect(secondResult).toEqual({
      pendingCategoryId: categoryId,
      pendingPromptRevisionId: originalDraft.id,
      pendingSelectionGeneration: 2,
    });
    expect(profile).toMatchObject({
      activeCategoryId: categoryId,
      activeCategoryActivatedAt: activeTime,
      pendingCategoryId: categoryId,
      pendingPromptRevisionId: originalDraft.id,
      pendingSelectionGeneration: 2,
      pendingSelectedAt: new Date("2026-09-30T12:05:00.000Z"),
    });
    expect(updatedDraft).toMatchObject({
      id: originalDraft.id,
      promptId,
      promptText: "Updated canonical English instructions",
      sourceTemplateId: templateId,
      sourceTemplateEditVersion: 8,
      editVersion: 2,
    });
    expect(lineages).toHaveLength(1);
    expect(configurations).toHaveLength(1);
    expect(configurations[0]?.activePromptRevisionId).toBe(activeRevisionId);
  }, 30_000);

  it("rejects a stale generation without changing the committed pending state", async () => {
    const db = requireDatabase();
    const shopId = await createShop();
    const firstResult = await select(shopId, 0);
    const beforeProfile = await db.commerceShopProfile.findUniqueOrThrow({
      where: { shopId },
    });
    const beforeRevisions = await db.commerceAgentPromptRevision.findMany({
      where: { prompt: { shopId, scope: "SHOP" } },
      orderBy: { revisionNumber: "asc" },
    });

    await expect(select(shopId, 0)).rejects.toMatchObject({ code: "CONFLICT" });

    expect(
      await db.commerceShopProfile.findUniqueOrThrow({ where: { shopId } }),
    ).toEqual(beforeProfile);
    expect(
      await db.commerceAgentPromptRevision.findMany({
        where: { prompt: { shopId, scope: "SHOP" } },
        orderBy: { revisionNumber: "asc" },
      }),
    ).toEqual(beforeRevisions);
    expect(firstResult.pendingSelectionGeneration).toBe(1);
  }, 30_000);

  it("rolls back profile creation and preserves an unrelated existing DRAFT", async () => {
    const db = requireDatabase();
    const shopId = await createShop();
    const { promptId } = await createPublishedShopPrompt(shopId);
    const unrelatedDraft = await db.commerceAgentPromptRevision.create({
      data: {
        promptId,
        revisionNumber: 2,
        status: "DRAFT",
        promptText: "Merchant-authored draft that must not be replaced",
        editVersion: 4,
      },
    });
    const beforeRevisions = await db.commerceAgentPromptRevision.findMany({
      where: { promptId },
      orderBy: { revisionNumber: "asc" },
    });

    await expect(select(shopId, 0)).rejects.toMatchObject({ code: "CONFLICT" });

    expect(
      await db.commerceShopProfile.findUnique({ where: { shopId } }),
    ).toBeNull();
    expect(
      await db.commerceAgentPrompt.findMany({
        where: { shopId, scope: "SHOP" },
      }),
    ).toHaveLength(1);
    const afterRevisions = await db.commerceAgentPromptRevision.findMany({
      where: { promptId },
      orderBy: { revisionNumber: "asc" },
    });
    expect(afterRevisions).toEqual(beforeRevisions);
    expect(
      afterRevisions.find((revision) => revision.id === unrelatedDraft.id),
    ).toMatchObject({
      status: "DRAFT",
      promptText: "Merchant-authored draft that must not be replaced",
      editVersion: 4,
    });
  }, 30_000);

  it("serializes concurrent generation-zero selections so exactly one creates the pending lineage and DRAFT", async () => {
    if (!firstClient || !secondClient) {
      throw new Error("Independent PostgreSQL clients are unavailable");
    }
    const db = requireDatabase();
    const shopId = await createShop();
    const outcomes = await Promise.allSettled([
      select(shopId, 0, firstClient),
      select(shopId, 0, secondClient),
    ]);
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status !== "rejected") {
      throw new Error("Expected the serialized stale selection to conflict");
    }
    expect(rejected[0].reason).toMatchObject({ code: "CONFLICT" });

    const profile = await db.commerceShopProfile.findUniqueOrThrow({
      where: { shopId },
    });
    const lineages = await db.commerceAgentPrompt.findMany({
      where: { shopId, scope: "SHOP" },
    });
    const drafts = await db.commerceAgentPromptRevision.findMany({
      where: { prompt: { shopId, scope: "SHOP" }, status: "DRAFT" },
    });
    expect(profile.pendingSelectionGeneration).toBe(1);
    expect(profile.pendingCategoryId).toBe(categoryId);
    expect(lineages).toHaveLength(1);
    expect(drafts).toHaveLength(1);
    expect(profile.pendingPromptRevisionId).toBe(drafts[0]?.id);
  }, 30_000);
});
