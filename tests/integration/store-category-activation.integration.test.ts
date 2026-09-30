import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

import { activateInitialPendingStoreCategoryIfEligible } from "../../app/services/store-profile/store-category-activation.server";

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
const fixturePrefix = `arch023-shopify003-${randomUUID()}`;
const pinnedPromptText = "Pinned canonical instructions\nSecond line.";
const activationTime = new Date("2026-09-30T19:00:00.000Z");

let postgres: StartedPostgreSqlContainer | undefined;
let database: PrismaClient | undefined;
let categoryId: string;
let templateId: string;
let replacementTemplateId: string;
let adminId: string;

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

type ActivationFixture = {
  shopId: string;
  promptId: string;
  pendingRevisionId: string;
  existingActiveRevisionId: string | null;
  configurationId: string | null;
  planId: string;
};

async function createActivationFixture(withConfiguration: boolean): Promise<ActivationFixture> {
  const db = requireDatabase();
  const shopId = `${fixturePrefix}-${randomUUID()}`;
  const plan = await db.billingPlan.create({
    data: {
      shopifyPlanHandle: `${fixturePrefix}-${randomUUID()}`,
      name: "Test Free Plan",
      kind: "FREE",
    },
  });
  await db.shop.create({
    data: { id: shopId, domain: `${shopId}.myshopify.com` },
  });
  await db.subscription.create({
    data: { shopId, planId: plan.id, status: "ACTIVE" },
  });

  const prompt = await db.commerceAgentPrompt.create({
    data: { scope: "SHOP", shopId },
  });
  const existingActiveRevision = withConfiguration
    ? await db.commerceAgentPromptRevision.create({
        data: {
          promptId: prompt.id,
          revisionNumber: 1,
          status: "PUBLISHED",
          promptText: "Previously active prompt",
          publishedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      })
    : null;
  const pendingRevision = await db.commerceAgentPromptRevision.create({
    data: {
      promptId: prompt.id,
      revisionNumber: withConfiguration ? 2 : 1,
      status: "DRAFT",
      promptText: pinnedPromptText,
      sourceTemplateId: templateId,
      sourceTemplateEditVersion: 7,
    },
  });
  const configuration = withConfiguration
    ? await db.commerceAgentConfiguration.create({
        data: {
          environment: "TEST",
          scope: "SHOP",
          shopId,
          activePromptRevisionId: existingActiveRevision!.id,
          promptEditVersion: 9,
        },
      })
    : null;
  await db.commerceShopProfile.create({
    data: {
      shopId,
      pendingCategoryId: categoryId,
      pendingPromptRevisionId: pendingRevision.id,
      pendingSelectionGeneration: 4,
      pendingSelectedAt: new Date("2026-09-29T12:00:00.000Z"),
    },
  });

  return {
    shopId,
    promptId: prompt.id,
    pendingRevisionId: pendingRevision.id,
    existingActiveRevisionId: existingActiveRevision?.id ?? null,
    configurationId: configuration?.id ?? null,
    planId: plan.id,
  };
}

describeWithDatabase("initial Store Category activation PostgreSQL transaction", () => {
  beforeAll(async () => {
    try {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      postgres = await new PostgreSqlContainer("pgvector/pgvector:pg17")
        .withDatabase(`arch023_s003_${suffix}`)
        .withUsername(`arch023_s003_${suffix}`)
        .withPassword(`test_${randomUUID().replaceAll("-", "")}`)
        .start();
      const databaseUrl = postgres.getConnectionUri();
      await deployMigrations(databaseUrl);
      database = new PrismaClient({ datasourceUrl: databaseUrl });
      await database.$connect();

      const admin = await database.platformAdmin.create({
        data: {
          email: `${fixturePrefix}@example.test`,
          role: "SUPER_ADMIN",
          active: true,
        },
      });
      adminId = admin.id;
      const category = await database.commercePromptTemplateCategory.create({
        data: {
          slug: fixturePrefix.slice(0, 120),
          displayName: "Activation Test Category",
          enabled: true,
          createdByAdminId: adminId,
          updatedByAdminId: adminId,
        },
      });
      const template = await database.commercePromptTemplate.create({
        data: {
          key: `${fixturePrefix.replaceAll("-", "_")}_template`,
          categoryId: category.id,
          displayName: "Activation Test Default",
          promptText: pinnedPromptText,
          enabled: true,
          editVersion: 7,
          createdByAdminId: adminId,
          updatedByAdminId: adminId,
        },
      });
      const replacementTemplate = await database.commercePromptTemplate.create({
        data: {
          key: `${fixturePrefix.replaceAll("-", "_")}_replacement_template`,
          categoryId: category.id,
          displayName: "Replacement Default Template B",
          promptText: "Replacement template text",
          enabled: true,
          editVersion: 1,
          createdByAdminId: adminId,
          updatedByAdminId: adminId,
        },
      });
      await database.commercePromptTemplateCategory.update({
        where: { id: category.id },
        data: { defaultTemplateId: template.id },
      });
      categoryId = category.id;
      templateId = template.id;
      replacementTemplateId = replacementTemplate.id;
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

  it("publishes the pinned revision and promotes profile/configuration atomically and idempotently", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
    const db = requireDatabase();
    const fixture = await createActivationFixture(false);
    await db.commercePromptTemplate.update({
      where: { id: templateId },
      data: { promptText: "Current template text changed after selection", editVersion: 8 },
    });
    await db.commercePromptTemplateCategory.update({
      where: { id: categoryId },
      data: { defaultTemplateId: replacementTemplateId },
    });

    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: fixture.shopId, expectedPendingSelectionGeneration: 4 },
      db,
      activationTime,
    )).resolves.toEqual({
      kind: "ACTIVATED",
      categoryId,
      promptRevisionId: fixture.pendingRevisionId,
    });

    const revision = await db.commerceAgentPromptRevision.findUniqueOrThrow({
      where: { id: fixture.pendingRevisionId },
    });
    const profile = await db.commerceShopProfile.findUniqueOrThrow({
      where: { shopId: fixture.shopId },
    });
    const configurations = await db.commerceAgentConfiguration.findMany({
      where: { shopId: fixture.shopId, scope: "SHOP", environment: "TEST" },
    });
    expect(revision).toMatchObject({
      status: "PUBLISHED",
      promptText: pinnedPromptText,
      sourceTemplateId: templateId,
      sourceTemplateEditVersion: 7,
      contentHash: createHash("sha256").update(pinnedPromptText, "utf8").digest("hex"),
      publishedAt: activationTime,
    });
    expect(profile).toMatchObject({
      activeCategoryId: categoryId,
      activeCategoryActivatedAt: activationTime,
      pendingCategoryId: null,
      pendingPromptRevisionId: null,
      pendingSelectedAt: null,
      pendingSelectionGeneration: 4,
    });
    expect(configurations).toHaveLength(1);
    expect(await db.commercePromptTemplateCategory.findUniqueOrThrow({
      where: { id: categoryId },
    })).toMatchObject({ defaultTemplateId: replacementTemplateId });
    expect(configurations[0]).toMatchObject({
      activePromptRevisionId: fixture.pendingRevisionId,
      promptEditVersion: 2,
      modelId: null,
      modelEditVersion: 1,
    });

    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: fixture.shopId }, db, new Date("2026-10-01T00:00:00.000Z"),
    )).resolves.toEqual({ kind: "ALREADY_ACTIVE" });
    expect(await db.commerceAgentConfiguration.findUniqueOrThrow({
      where: { id: configurations[0]!.id },
    })).toMatchObject({
      activePromptRevisionId: fixture.pendingRevisionId,
      promptEditVersion: 2,
    });
    expect(await db.subscription.findUniqueOrThrow({ where: { shopId: fixture.shopId } }))
      .toMatchObject({ status: "ACTIVE", planId: fixture.planId });
  }, 30_000);

  it("rolls back publication/configuration/profile when promotion fails without undoing billing", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
    const db = requireDatabase();
    const fixture = await createActivationFixture(true);
    const constraint = `arch023_s003_fail_${randomUUID().replaceAll("-", "")}`;
    await db.$executeRawUnsafe(
      `ALTER TABLE "commerce"."CommerceShopProfile" ADD CONSTRAINT "${constraint}" CHECK ("shopId" <> '${fixture.shopId}' OR "activeCategoryId" IS NULL)`,
    );

    try {
      await expect(activateInitialPendingStoreCategoryIfEligible(
        { shopId: fixture.shopId }, db, activationTime,
      )).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "commerce"."CommerceShopProfile" DROP CONSTRAINT "${constraint}"`,
      );
    }

    const [revision, profile, configuration, subscription] = await Promise.all([
      db.commerceAgentPromptRevision.findUniqueOrThrow({
        where: { id: fixture.pendingRevisionId },
      }),
      db.commerceShopProfile.findUniqueOrThrow({ where: { shopId: fixture.shopId } }),
      db.commerceAgentConfiguration.findUniqueOrThrow({
        where: { id: fixture.configurationId! },
      }),
      db.subscription.findUniqueOrThrow({ where: { shopId: fixture.shopId } }),
    ]);
    expect(revision).toMatchObject({ status: "DRAFT", contentHash: null, publishedAt: null });
    expect(profile).toMatchObject({
      activeCategoryId: null,
      pendingCategoryId: categoryId,
      pendingPromptRevisionId: fixture.pendingRevisionId,
      pendingSelectionGeneration: 4,
    });
    expect(configuration).toMatchObject({
      activePromptRevisionId: fixture.existingActiveRevisionId,
      promptEditVersion: 9,
    });
    expect(subscription).toMatchObject({ status: "ACTIVE", planId: fixture.planId });
  }, 30_000);
});