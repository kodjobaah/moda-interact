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
const fixturePrefix = `arch054-shopify-control-${randomUUID()}`;
const featureId = `${fixturePrefix}-feature`;
const planId = `${fixturePrefix}-plan`;
const planHandle = `${fixturePrefix}-plan-handle`;
const featureKey = "checkout_recovery";
const shopId = `${fixturePrefix}-shop`;

let postgres: StartedPostgreSqlContainer | undefined;
let database: PrismaClient | undefined;
let firstClient: PrismaClient | undefined;
let secondClient: PrismaClient | undefined;
let changeRecoveryControl:
  typeof import("../../app/services/recoveries/recovery-human-commands.server")["changeRecoveryControl"];
const recoveryIds: string[] = [];
const conversationIds: string[] = [];

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

async function createRecovery(input: {
  label: string;
  mode: "AI" | "HUMAN";
  revision: number;
  inboundVersion: number;
}) {
  const db = requireDatabase();
  const recoveryId = `${fixturePrefix}-${input.label}-recovery`;
  const conversationId = `${fixturePrefix}-${input.label}-conversation`;
  const pendingAt = new Date("2026-10-31T12:00:00.000Z");
  recoveryIds.push(recoveryId);
  conversationIds.push(conversationId);
  await db.checkoutRecovery.create({
    data: {
      id: recoveryId,
      shopId,
      checkoutToken: `${fixturePrefix}-${input.label}-checkout`,
      status: "ENGAGED",
      lastExternalActivityAt: pendingAt,
      conversation: {
        create: {
          id: conversationId,
          shopId,
          type: "RECOVERY",
          controlMode: input.mode,
          controlRevision: input.revision,
          inboundVersion: input.inboundVersion,
          lastProcessedVersion: input.inboundVersion - 2,
          pendingTurnStartedAt: pendingAt,
          pendingAiNotBeforeAt: new Date(pendingAt.getTime() + 7 * 60_000),
          pendingAiControlRevision: input.revision,
          pendingAiDelayMinutes: 7,
          processingInboundVersion: input.inboundVersion,
          processingStartedAt: pendingAt,
        },
      },
    },
  });
  return { recoveryId, conversationId };
}

function clientWithControlEventFailure(client: PrismaClient): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>,
        options?: Parameters<PrismaClient["$transaction"]>[1],
      ) => target.$transaction((transaction) => {
        const failingEvents = new Proxy(transaction.conversationControlEvent, {
          get(delegate, method) {
            if (method === "create") return async () => { throw new Error("injected control event failure"); };
            const value = Reflect.get(delegate, method, delegate);
            return typeof value === "function" ? value.bind(delegate) : value;
          },
        });
        const transactionProxy = new Proxy(transaction, {
          get(current, key) {
            if (key === "conversationControlEvent") return failingEvents;
            const value = Reflect.get(current, key, current);
            return typeof value === "function" ? value.bind(current) : value;
          },
        });
        return callback(transactionProxy);
      }, options);
    },
  });
}

describeWithDatabase("Shopify recovery-control PostgreSQL transaction fencing", () => {
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("pgvector/pgvector:pg17")
      .withDatabase("shopify_control_test")
      .withUsername("shopify_control_test")
      .withPassword(`test_${randomUUID().replaceAll("-", "")}`)
      .start();
    const databaseUrl = postgres.getConnectionUri();
    await deployMigrations(databaseUrl);
    database = new PrismaClient({ datasourceUrl: databaseUrl });
    firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
    secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
    await Promise.all([database.$connect(), firstClient.$connect(), secondClient.$connect()]);
    ({ changeRecoveryControl } = await import(
      "../../app/services/recoveries/recovery-human-commands.server"
    ));
    await database.feature.create({
      data: {
        id: featureId,
        key: featureKey,
        displayName: "ARCH-054 test recovery",
        activationMode: "ALWAYS_ENABLED",
      },
    });
    await database.billingPlan.create({
      data: {
        id: planId,
        shopifyPlanHandle: planHandle,
        name: "ARCH-054 control test plan",
        kind: "PAID_METERED",
        features: { create: { featureId, enabled: true } },
      },
    });
    await database.shop.create({
      data: { id: shopId, domain: `${shopId}.myshopify.com`, status: "ACTIVE" },
    });
    await database.subscription.create({
      data: { shopId, planId, status: "ACTIVE", observedShopifyPlanHandle: planHandle },
    });
  }, 240_000);

  afterAll(async () => {
    try {
      if (database) {
        await database.conversationControlEvent.deleteMany({ where: { conversationId: { in: conversationIds } } });
        await database.conversation.deleteMany({ where: { id: { in: conversationIds } } });
        await database.checkoutRecovery.deleteMany({ where: { id: { in: recoveryIds } } });
        await database.subscription.deleteMany({ where: { shopId } });
        await database.shop.deleteMany({ where: { id: shopId } });
        await database.billingPlan.deleteMany({ where: { id: planId } });
        await database.feature.deleteMany({ where: { id: featureId } });
      }
    } finally {
      await Promise.allSettled([
        firstClient?.$disconnect() ?? Promise.resolve(),
        secondClient?.$disconnect() ?? Promise.resolve(),
        database?.$disconnect() ?? Promise.resolve(),
      ]);
      await postgres?.stop();
    }
  }, 60_000);

  it("allows one concurrent takeover and atomically invalidates the pending turn", async () => {
    if (!firstClient || !secondClient) throw new Error("Disposable PostgreSQL clients are unavailable");
    const { recoveryId, conversationId } = await createRecovery({
      label: "race", mode: "AI", revision: 4, inboundVersion: 12,
    });
    const outcomes = await Promise.allSettled([
      changeRecoveryControl(shopId, recoveryId, { targetMode: "HUMAN", expectedControlRevision: 4 }, firstClient),
      changeRecoveryControl(shopId, recoveryId, { targetMode: "HUMAN", expectedControlRevision: 4 }, secondClient),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const conversation = await requireDatabase().conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation).toMatchObject({
      controlMode: "HUMAN",
      controlRevision: 5,
      inboundVersion: 12,
      lastProcessedVersion: 12,
      pendingTurnStartedAt: null,
      pendingAiNotBeforeAt: null,
      pendingAiControlRevision: null,
      pendingAiDelayMinutes: null,
      processingInboundVersion: null,
      processingStartedAt: null,
    });
    expect(await requireDatabase().conversationControlEvent.count({ where: { conversationId } })).toBe(1);
  }, 30_000);

  it("rolls back invalidation when the control event cannot be persisted", async () => {
    if (!firstClient) throw new Error("Disposable PostgreSQL client is unavailable");
    const { recoveryId, conversationId } = await createRecovery({
      label: "rollback", mode: "AI", revision: 8, inboundVersion: 21,
    });

    await expect(changeRecoveryControl(
      shopId,
      recoveryId,
      { targetMode: "HUMAN", expectedControlRevision: 8 },
      clientWithControlEventFailure(firstClient),
    )).rejects.toThrow("injected control event failure");

    const conversation = await requireDatabase().conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation).toMatchObject({
      controlMode: "AI",
      controlRevision: 8,
      lastProcessedVersion: 19,
      pendingAiControlRevision: 8,
      pendingAiDelayMinutes: 7,
      processingInboundVersion: 21,
    });
    expect(conversation.pendingAiNotBeforeAt).not.toBeNull();
    expect(conversation.pendingTurnStartedAt).not.toBeNull();
    expect(await requireDatabase().conversationControlEvent.count({ where: { conversationId } })).toBe(0);
  }, 30_000);

  it("preserves a fresh turn when a request carries the prior control revision", async () => {
    if (!firstClient) throw new Error("Disposable PostgreSQL client is unavailable");
    const { recoveryId, conversationId } = await createRecovery({
      label: "stale", mode: "HUMAN", revision: 2, inboundVersion: 30,
    });
    await changeRecoveryControl(shopId, recoveryId, { targetMode: "AI", expectedControlRevision: 2 }, firstClient);
    const nextTurnAt = new Date("2026-10-31T13:00:00.000Z");
    await requireDatabase().conversation.update({
      where: { id: conversationId },
      data: {
        inboundVersion: 31,
        pendingTurnStartedAt: nextTurnAt,
        pendingAiNotBeforeAt: new Date(nextTurnAt.getTime() + 7 * 60_000),
        pendingAiControlRevision: 3,
        pendingAiDelayMinutes: 7,
        processingInboundVersion: 31,
        processingStartedAt: nextTurnAt,
      },
    });

    await expect(changeRecoveryControl(
      shopId,
      recoveryId,
      { targetMode: "HUMAN", expectedControlRevision: 2 },
      firstClient,
    )).rejects.toMatchObject({ code: "stale_control_revision" });

    const conversation = await requireDatabase().conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation).toMatchObject({
      controlMode: "AI",
      controlRevision: 3,
      inboundVersion: 31,
      lastProcessedVersion: 30,
      pendingAiControlRevision: 3,
      pendingAiDelayMinutes: 7,
      processingInboundVersion: 31,
    });
    expect(conversation.pendingAiNotBeforeAt).toEqual(new Date(nextTurnAt.getTime() + 7 * 60_000));
    expect(conversation.pendingTurnStartedAt).toEqual(nextTurnAt);
  }, 30_000);
});
