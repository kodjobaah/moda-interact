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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const execFileAsync = promisify(execFile);
const integrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === "1";
const describeWithDatabase = integrationEnabled ? describe : describe.skip;
const postgresImage = "postgres:17.6-alpine";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const prismaExecutable = resolve(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);

const fixtureId = randomUUID();
const adminId = `admin-${fixtureId}`;
const planId = `plan-${fixtureId}`;
const shopId = `shop-${fixtureId}`;
const campaignAId = `campaign-a-${fixtureId}`;
const campaignBId = `campaign-b-${fixtureId}`;
const selectionTime = new Date("2026-09-13T12:00:00.000Z");

let postgres: StartedPostgreSqlContainer | undefined;
let database: PrismaClient | undefined;
let firstClient: PrismaClient | undefined;
let secondClient: PrismaClient | undefined;
let selectPromotionOffer:
  typeof import("../../app/services/promotions/promotion.service")["selectPromotionOffer"];

const originalDatabaseUrl = process.env.DATABASE_URL;

async function deployMigrations(databaseUrl: string): Promise<void> {
  await execFileAsync(
    prismaExecutable,
    ["migrate", "deploy", "--schema", "database/prisma/schema.prisma"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function disconnectClients(): Promise<void> {
  await Promise.allSettled([
    database?.$disconnect() ?? Promise.resolve(),
    firstClient?.$disconnect() ?? Promise.resolve(),
    secondClient?.$disconnect() ?? Promise.resolve(),
  ]);
}

async function resetSelection(): Promise<void> {
  if (!database) throw new Error("Disposable database client is unavailable");
  await database.merchantPromotionSelection.deleteMany({ where: { shopId } });
  await database.promotionalCreditGrant.deleteMany({ where: { shopId } });
}

async function createCommonFixtures(): Promise<void> {
  if (!database) throw new Error("Disposable database client is unavailable");
  await database.platformAdmin.create({
    data: {
      id: adminId,
      email: `${adminId}@example.test`,
      role: "SUPER_ADMIN",
      active: true,
    },
  });
  await database.billingPlan.create({
    data: {
      id: planId,
      shopifyPlanHandle: planId,
      name: "Promotion integration plan",
      kind: "PAID_METERED",
      active: true,
      shopifyUsageEventHandle: "promotion-meter",
      includedRecoveryConversationAllowance: 100,
      defaultOutboundSoftLimit: 10,
      defaultOutboundHardLimit: 20,
      terminalMessageReservedSlots: 1,
    },
  });
  await database.shop.create({
    data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" },
  });
  await database.subscription.create({
    data: {
      shopId,
      planId,
      status: "ACTIVE",
      observedShopifyPlanHandle: planId,
    },
  });
  await database.promotionCampaign.createMany({
    data: [
      {
        id: campaignAId,
        name: "Campaign A",
        merchantDescription: "A",
        scope: "GLOBAL",
        quantity: 25,
        startsAt: new Date("2026-09-01T00:00:00.000Z"),
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        status: "ACTIVE",
        createdByPlatformAdminId: adminId,
      },
      {
        id: campaignBId,
        name: "Campaign B",
        merchantDescription: "B",
        scope: "GLOBAL",
        quantity: 40,
        startsAt: new Date("2026-09-01T00:00:00.000Z"),
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        status: "ACTIVE",
        createdByPlatformAdminId: adminId,
      },
    ],
  });
}

describeWithDatabase(
  "Promotion selection PostgreSQL concurrency (Testcontainers)",
  () => {
    beforeAll(async () => {
      try {
        postgres = await new PostgreSqlContainer(postgresImage)
          .withDatabase("moda_interact_test")
          .withUsername("moda_test")
          .withPassword("moda_test_password")
          .start();
        const databaseUrl = postgres.getConnectionUri();
        process.env.DATABASE_URL = databaseUrl;
        await deployMigrations(databaseUrl);
        database = new PrismaClient({ datasourceUrl: databaseUrl });
        firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
        secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
        await Promise.all([
          database.$connect(),
          firstClient.$connect(),
          secondClient.$connect(),
        ]);
        ({ selectPromotionOffer } = await import(
          "../../app/services/promotions/promotion.service"
        ));
        await createCommonFixtures();
      } catch (error) {
        await disconnectClients();
        await postgres?.stop();
        postgres = undefined;
        throw error;
      }
    }, 120_000);

    beforeEach(resetSelection);
    afterEach(resetSelection);

    afterAll(async () => {
      try {
        if (database) {
          await database.merchantPromotionSelection.deleteMany({ where: { shopId } });
          await database.promotionalCreditGrant.deleteMany({ where: { shopId } });
          await database.promotionCampaign.deleteMany({ where: { id: { in: [campaignAId, campaignBId] } } });
          await database.subscription.deleteMany({ where: { shopId } });
          await database.shop.deleteMany({ where: { id: shopId } });
          await database.billingPlan.deleteMany({ where: { id: planId } });
          await database.platformAdmin.deleteMany({ where: { id: adminId } });
        }
      } finally {
        await disconnectClients();
        await postgres?.stop();
        postgres = undefined;
        if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }, 120_000);

    it(
      "allows exactly one winner when two different campaigns are selected concurrently",
      async () => {
        if (!database || !firstClient || !secondClient) throw new Error("Disposable database clients are unavailable");
        const candidates = [
          { campaignId: campaignAId, quantity: 25 },
          { campaignId: campaignBId, quantity: 40 },
        ] as const;
        const outcomes = await Promise.allSettled([
          selectPromotionOffer(shopId, campaignAId, selectionTime, firstClient),
          selectPromotionOffer(shopId, campaignBId, selectionTime, secondClient),
        ]);
        const fulfilledIndexes = outcomes
          .map((outcome, index) => ({ outcome, index }))
          .filter(({ outcome }) => outcome.status === "fulfilled")
          .map(({ index }) => index);
        expect(fulfilledIndexes).toHaveLength(1);
        const winningIndex = fulfilledIndexes[0];
        if (winningIndex !== 0 && winningIndex !== 1) throw new Error("Expected exactly one fulfilled promotion selection");
        const losingIndex = winningIndex === 0 ? 1 : 0;
        const winningCampaign = candidates[winningIndex];
        const losingCampaign = candidates[losingIndex];
        const losingOutcome = outcomes[losingIndex];
        expect(losingOutcome.status).toBe("rejected");
        if (losingOutcome.status !== "rejected") throw new Error("Expected the losing promotion selection to reject");
        expect(losingOutcome.reason).toMatchObject({ code: "ACTIVE_PROMOTION_ALREADY_SELECTED" });
        expect(await database.merchantPromotionSelection.count({ where: { shopId } })).toBe(1);
        expect(await database.promotionalCreditGrant.count({ where: { shopId } })).toBe(1);
        const selection = await database.merchantPromotionSelection.findUnique({ where: { shopId }, include: { promotionalCreditGrant: true } });
        expect(selection).not.toBeNull();
        expect(selection?.promotionalCreditGrant.campaignId).toBe(winningCampaign.campaignId);
        expect(selection?.promotionalCreditGrant.quantity).toBe(winningCampaign.quantity);
        expect(await database.promotionalCreditGrant.count({ where: { campaignId: losingCampaign.campaignId, shopId } })).toBe(0);
      },
      30_000,
    );

    it(
      "reuses one exact grant when the same campaign is selected concurrently",
      async () => {
        if (!database || !firstClient || !secondClient) throw new Error("Disposable database clients are unavailable");
        const outcomes = await Promise.allSettled([
          selectPromotionOffer(shopId, campaignAId, selectionTime, firstClient),
          selectPromotionOffer(shopId, campaignAId, selectionTime, secondClient),
        ]);
        expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
        const grants = await database.promotionalCreditGrant.findMany({ where: { campaignId: campaignAId, shopId } });
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({ quantity: 25, selectionCount: 2 });
        const selection = await database.merchantPromotionSelection.findUnique({ where: { shopId } });
        expect(selection).not.toBeNull();
        expect(selection?.promotionalCreditGrantId).toBe(grants[0]?.id);
      },
      30_000,
    );
  },
);
