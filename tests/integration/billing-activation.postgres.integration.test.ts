import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingService } from "../../app/services/billing/billing.service";
import { persistShopifyOnboardingMilestone } from "../../app/services/billing/onboarding-milestone.server";
import { createPaidActivationFixture } from "../fixtures/billing-activation";
import {
  startBillingPostgresFixture,
  type BillingPostgresFixture,
  type QueryLoggingPrismaClient,
} from "../helpers/billing-postgres";
import type { ProviderSubscription } from "../../app/services/billing/billing.types";

const integrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === "1";
const describeWithDatabase = integrationEnabled ? describe : describe.skip;
const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");

let fixture: BillingPostgresFixture | undefined;
let queryLog: string[];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value?: T) => resolve(value as T) };
}

function paidProvider(planHandle: string, usageEventHandle: string): ProviderSubscription {
  return {
    provider: "SHOPIFY",
    planHandle,
    billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: {
      handle: planHandle,
      description: "Integration plan",
      price: { amount: "12.00", currency: "USD" },
    },
    pendingFlatRatePlan: null,
    usageItems: [],
    usageEventHandles: [usageEventHandle],
    pendingPlanHandle: null,
    pendingEffectiveAt: null,
    status: "ACTIVE",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: `gid://shopify/AppSubscription/${planHandle}`,
    providerUsageSnapshot: [],
  };
}

function recordQueries(client: QueryLoggingPrismaClient) {
  client.$on("query", (event) => queryLog.push(event.query));
}

function proxyTransactionClient(
  client: PrismaClient,
  wrap: (transaction: Prisma.TransactionClient) => Prisma.TransactionClient,
): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (
          callback: (transaction: Prisma.TransactionClient) => Promise<unknown>,
          options?: Parameters<PrismaClient["$transaction"]>[1],
        ) => target.$transaction((transaction) => callback(wrap(transaction)), options);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function billingServiceFor(
  database: PrismaClient,
  planHandle: string,
  meter: string,
  providerPort: { getActiveSubscription: () => Promise<ProviderSubscription> } = {
    getActiveSubscription: async () => paidProvider(planHandle, meter),
  },
) {
  return new BillingService(providerPort as never, database);
}

async function waitForDatabaseLockWait(observer: PrismaClient, applicationName: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const waiting = await observer.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND wait_event_type = 'Lock'
    `);
    if (waiting.length > 0) return waiting[0]!.pid;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`PostgreSQL did not report a lock wait for ${applicationName}`);
}

describeWithDatabase("Billing activation PostgreSQL locks and projections", () => {
  beforeAll(async () => {
    fixture = await startBillingPostgresFixture();
    queryLog = [];
    recordQueries(fixture.database);
  }, 240_000);

  afterAll(async () => {
    await fixture?.cleanup();
  }, 60_000);

  it("finalizes initial Paid activation once and repairs a missing counter without updating the unchanged period", async () => {
    const database = fixture!.database;
    const seed = await createPaidActivationFixture(database, "paid-replay");
    const service = billingServiceFor(database, seed.planHandle, seed.usageEventHandle);
    const activation = await service.preparePaidActivation(seed.shopId, seed.planHandle);
    expect(activation?.token).toBeTruthy();

    const firstSync = fixture!.createClient("billing-same-token-first");
    const secondSync = fixture!.createClient("billing-same-token-second");
    const bothProviderRequestsArrived = deferred();
    const releaseProviderRequests = deferred();
    let providerRequestCount = 0;
    const barrierProvider = { getActiveSubscription: async () => {
      providerRequestCount += 1;
      if (providerRequestCount === 2) bothProviderRequestsArrived.resolve();
      await releaseProviderRequests.promise;
      return paidProvider(seed.planHandle, seed.usageEventHandle);
    } };
    const firstService = billingServiceFor(firstSync, seed.planHandle, seed.usageEventHandle, barrierProvider);
    const secondService = billingServiceFor(secondSync, seed.planHandle, seed.usageEventHandle, barrierProvider);
    const concurrentResultsPromise = Promise.all([
      firstService.syncSubscription(seed.shopId, activation!.token!),
      secondService.syncSubscription(seed.shopId, activation!.token!),
    ]);
    await bothProviderRequestsArrived.promise;
    expect(providerRequestCount).toBe(2);
    releaseProviderRequests.resolve();
    const concurrentResults = await concurrentResultsPromise;
    expect(concurrentResults.filter(Boolean)).toHaveLength(1);
    expect(concurrentResults.filter((result) => result === null)).toHaveLength(1);
    const finalized = concurrentResults.find((result) => result !== null)!;
    expect(finalized).toMatchObject({ status: "ACTIVE", planId: seed.planId });
    const period = await database.billingPeriod.findUniqueOrThrow({ where: { id: finalized!.billingPeriodId! } });
    expect(await database.billingPeriod.count({ where: { shopId: seed.shopId } })).toBe(1);
    expect(await database.billingPeriodEntitlementCounter.count({ where: { billingPeriodId: period.id } })).toBe(1);
    expect(await database.shopEntitlementCounter.count({ where: { shopId: seed.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } })).toBe(1);

    const updatedAt = period.updatedAt;
    await database.billingPeriodEntitlementCounter.deleteMany({ where: { billingPeriodId: period.id } });
    queryLog = [];
    const staleReplay = await service.syncSubscription(seed.shopId, activation!.token!);
    expect(staleReplay).toBeNull();
    queryLog = [];
    const counterRepaired = await service.syncSubscription(seed.shopId);
    expect(counterRepaired?.status).toBe("ACTIVE");

    const replayedPeriod = await database.billingPeriod.findUniqueOrThrow({ where: { id: period.id } });
    expect(replayedPeriod.updatedAt).toEqual(updatedAt);
    expect(await database.billingPeriodEntitlementCounter.count({ where: { billingPeriodId: period.id } })).toBe(1);
    expect(queryLog.some((query) => /UPDATE\s+"billing"\."BillingPeriod"/i.test(query))).toBe(false);
    expect(queryLog.some((query) => /INSERT INTO\s+"billing"\."BillingPeriodEntitlementCounter"/i.test(query))).toBe(true);
    expect(queryLog.filter((query) => /FOR UPDATE/i.test(query)).map((query) => query.match(/FROM\s+"[^"]+"\."[^"]+"/i)?.[0])).toEqual([
      'FROM "commerce"."Shop"',
      'FROM "shopify"."ShopSettings"',
      'FROM "billing"."Subscription"',
    ]);
  }, 60_000);

  it("serializes a real onboarding milestone against initial activation and rolls back a failed second milestone write", async () => {
    const database = fixture!.database;
    const activationClient = fixture!.createClient("billing-activation-lock-holder");
    const milestoneClient = fixture!.createClient("billing-onboarding-milestone-waiter");
    const observer = fixture!.createClient("billing-lock-observer");
    const seed = await createPaidActivationFixture(database, "concurrent-milestone");
    const locked = deferred();
    const releaseActivation = deferred();

    const heldActivationClient = proxyTransactionClient(activationClient, (transaction) => new Proxy(transaction, {
      get(target, property, receiver) {
        if (property === "$queryRaw") {
          return async (...args: unknown[]) => {
            const query = Reflect.get(target, property, target) as (...values: unknown[]) => Promise<unknown>;
            const result = await query.apply(target, args);
            if (locked.resolve && !lockedResolved) {
              lockedResolved = true;
              locked.resolve();
              await releaseActivation.promise;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Prisma.TransactionClient);
    const service = billingServiceFor(heldActivationClient, seed.planHandle, seed.usageEventHandle);
    let lockedResolved = false;
    const activationPromise = service.preparePaidActivation(seed.shopId, seed.planHandle);
    await locked.promise;

    const milestonePromise = persistShopifyOnboardingMilestone(seed.shopId, milestoneClient);
    const lockWaitPid = await waitForDatabaseLockWait(observer, "billing-onboarding-milestone-waiter");
    expect(lockWaitPid).toBeGreaterThan(0);
    releaseActivation.resolve();
    const activation = await activationPromise;
    await milestonePromise;
    expect(activation?.token).toBeTruthy();
    expect(await database.shop.findUniqueOrThrow({ where: { id: seed.shopId } })).toMatchObject({ onboardingCompleted: true });
    expect(await database.shopSettings.findUniqueOrThrow({ where: { shopId: seed.shopId } })).toMatchObject({ onboardingCompleted: true });
    const rollbackSeed = await createPaidActivationFixture(database, "milestone-rollback");
    let firstWriteCount = 0;
    const failingClient = proxyTransactionClient(fixture!.createClient("billing-milestone-rollback"), (transaction) => new Proxy(transaction, {
      get(target, property, receiver) {
        if (property === "shop") {
          const shopDelegate = Reflect.get(target, property, target) as object;
          return new Proxy(shopDelegate, {
            get(delegate, method, delegateReceiver) {
              if (method === "updateMany") return async (args: unknown) => {
                const update = Reflect.get(delegate, method, delegate) as (input: unknown) => Promise<{ count: number }>;
                const result = await update.call(delegate, args);
                firstWriteCount = result.count;
                return result;
              };
              return Reflect.get(delegate, method, delegateReceiver);
            },
          });
        }
        if (property === "shopSettings") {
          const settingsDelegate = Reflect.get(target, property, target) as object;
          return new Proxy(settingsDelegate, {
            get(delegate, method, delegateReceiver) {
              if (method === "updateMany") return async () => { throw Object.assign(new Error("injected second milestone update failure"), { code: "P2025" }); };
              return Reflect.get(delegate, method, delegateReceiver);
            },
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Prisma.TransactionClient);

    await expect(persistShopifyOnboardingMilestone(rollbackSeed.shopId, failingClient))
      .rejects.toThrow("injected second milestone update failure");
    expect(firstWriteCount).toBe(1);
    expect(await database.shop.findUniqueOrThrow({ where: { id: rollbackSeed.shopId } })).toMatchObject({ onboardingCompleted: false });
    expect(await database.shopSettings.findUniqueOrThrow({ where: { shopId: rollbackSeed.shopId } })).toMatchObject({ onboardingCompleted: false });
  }, 60_000);
});
