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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const fixturePrefix = `shopify-discounts-${randomUUID()}`;
const shopA = `${fixturePrefix}-a`;
const shopB = `${fixturePrefix}-b`;
const discountA = `${fixturePrefix}-discount-a`;
const discountB = `${fixturePrefix}-discount-b`;
const discountNew = `${fixturePrefix}-discount-new`;
const now = new Date("2026-10-30T12:00:00.000Z");

let postgres: StartedPostgreSqlContainer | undefined;
let database: PrismaClient | undefined;
let firstClient: PrismaClient | undefined;
let secondClient: PrismaClient | undefined;
let saveMerchantRecoveryPolicy:
  typeof import("../../app/services/recovery-policy/recovery-policy.server")["saveMerchantRecoveryPolicy"];

async function deployMigrations(databaseUrl: string) {
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

function requireDatabase() {
  if (!database) throw new Error("Disposable PostgreSQL client is unavailable");
  return database;
}

async function createShop(shopId: string, ids: string[]) {
  const db = requireDatabase();
  await db.shop.create({ data: { id: shopId, domain: `${shopId}.myshopify.com` } });
  await db.shopSettings.create({ data: { shopId } });
  await db.shopifyDiscountCatalogue.create({ data: { shopId, status: "ERROR", syncGeneration: 4 } });
  await db.shopifyDiscount.createMany({
    data: ids.map((id, index) => ({
      id,
      shopId,
      shopifyDiscountNodeId: `gid://shopify/Discount/${id}`,
      providerType: "DiscountCodeBasic",
      method: "CODE" as const,
      providerStatus: index === 0 ? "EXPIRED" : "ACTIVE",
      title: id,
      providerSnapshot: {},
      lastSeenSyncGeneration: index === 0 ? 3 : 4,
      lastSyncedAt: now,
      isAvailable: index === 0,
    })),
  });
}

function input(
  selectedDiscountIds: string[],
  recoveryOfferMode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE" = "NONE",
) {
  return {
    recoveryDelayMinutes: "30",
    recoveryOfferMode,
    selectedDiscountIds,
    followUpEnabled: "false",
    followUpDelayMinutes: "",
    notifyOnInitialRecoveryOutreach: false,
  };
}

async function save(shopId: string, ids: string[], mode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE", revision: string, client: PrismaClient = requireDatabase()) {
  return saveMerchantRecoveryPolicy(shopId, input(ids, mode), revision, client);
}

async function revision(shopId: string) {
  return (await requireDatabase().shopSettings.findUniqueOrThrow({ where: { shopId } })).updatedAt.toISOString();
}

describeWithDatabase("Shopify recovery discount PostgreSQL transactions", () => {
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withDatabase("shopify_recovery_test")
      .withUsername("shopify_recovery_test")
      .withPassword(`test_${randomUUID().replaceAll("-", "")}`)
      .start();
    const databaseUrl = postgres.getConnectionUri();
    await deployMigrations(databaseUrl);
    database = new PrismaClient({ datasourceUrl: databaseUrl });
    firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
    secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
    await Promise.all([database.$connect(), firstClient.$connect(), secondClient.$connect()]);
    ({ saveMerchantRecoveryPolicy } = await import(
      "../../app/services/recovery-policy/recovery-policy.server"
    ));
    await createShop(shopA, [discountA, discountNew]);
    await createShop(shopB, [discountB]);
  }, 240_000);

  afterAll(async () => {
    try {
      await Promise.allSettled([
        firstClient?.$disconnect() ?? Promise.resolve(),
        secondClient?.$disconnect() ?? Promise.resolve(),
        database?.$disconnect() ?? Promise.resolve(),
      ]);
    } finally {
      await postgres?.stop();
    }
  }, 60_000);

  it("rejects another shop's discount without changing either tenant", async () => {
    const beforeRevision = await revision(shopA);
    await expect(save(shopA, [discountB], "FIXED", beforeRevision)).rejects.toMatchObject({
      code: "INVALID_DISCOUNT_SELECTION",
    });
    expect(await requireDatabase().shopifyDiscount.findUniqueOrThrow({ where: { id: discountA } })).toMatchObject({ isAvailable: true });
    expect(await requireDatabase().shopifyDiscount.findUniqueOrThrow({ where: { id: discountB } })).toMatchObject({ isAvailable: true });
    expect(await revision(shopA)).toBe(beforeRevision);
  });

  it("keeps new sync rows unchecked, allows dormant selections, and is idempotent", async () => {
    const db = requireDatabase();
    const before = await revision(shopA);
    const first = await save(shopA, [discountA], "FIXED", before);
    const updatedRevision = first.updatedAt.toISOString();
    expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: discountA } })).toMatchObject({
      isAvailable: true,
      providerStatus: "EXPIRED",
    });
    expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: discountNew } })).toMatchObject({ isAvailable: false });

    const second = await save(shopA, [discountA], "FIXED", updatedRevision);
    expect(second.updatedAt.toISOString()).toBe(updatedRevision);
    const none = await save(shopA, [discountA], "NONE", updatedRevision);
    expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: discountA } })).toMatchObject({ isAvailable: true });
    const ai = await save(shopA, [discountA], "AI_BEST_APPLICABLE", none.updatedAt.toISOString());
    expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: discountA } })).toMatchObject({ isAvailable: true });
    await save(shopA, [], "NONE", ai.updatedAt.toISOString());
    expect(await db.shopifyDiscount.findUniqueOrThrow({ where: { id: discountA } })).toMatchObject({ isAvailable: false });
  });

  it("serializes concurrent saves and rejects the stale revision without partial writes", async () => {
    if (!firstClient || !secondClient) throw new Error("Independent PostgreSQL clients are unavailable");
    const expectedRevision = await revision(shopA);
    const results = await Promise.allSettled([
      save(shopA, [discountA], "FIXED", expectedRevision, firstClient),
      save(shopA, [discountNew], "FIXED", expectedRevision, secondClient),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { message: "CONFLICT" } });
    const settings = await requireDatabase().shopSettings.findUniqueOrThrow({ where: { shopId: shopA } });
    const selected = await requireDatabase().shopifyDiscount.findMany({ where: { shopId: shopA, isAvailable: true }, select: { id: true } });
    expect(selected.map((row) => row.id)).toEqual([settings.fixedShopifyDiscountId]);
  }, 30_000);
});
