import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deferred, startLifecyclePostgres, type LifecyclePostgres } from "../helpers/shopify-lifecycle-postgres";
import { lockShopLifecycleRow } from "../../app/services/discounts/shopify-discount-lifecycle.service";

const enabled = process.env.MODA_SHOPIFY_LIFECYCLE_POSTGRES === "1";
const describeWithPostgres = enabled ? describe : describe.skip;
let fixture: LifecyclePostgres | undefined;

function requireFixture() {
  if (!fixture) throw new Error("Shopify lifecycle PostgreSQL fixture is unavailable");
  return fixture;
}

function clientWithTransitionBarrier(client: PrismaClient, reached: () => void, release: Promise<void>): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>,
        options?: Parameters<PrismaClient["$transaction"]>[1],
      ) => target.$transaction((transaction) => {
        const shop = new Proxy(transaction.shop, {
          get(delegate, method) {
            const original = Reflect.get(delegate, method, delegate);
            if (method !== "updateMany") return typeof original === "function" ? original.bind(delegate) : original;
            return async (args: Parameters<typeof transaction.shop.updateMany>[0]) => {
              const result = await Reflect.apply(original, delegate, [args]) as { count: number };
              if (args.data.status === "UNINSTALLED" && result.count === 1) {
                reached();
                await release;
              }
              return result;
            };
          },
        });
        const proxy = new Proxy(transaction, {
          get(current, key) {
            if (key === "shop") return shop;
            const value = Reflect.get(current, key, current);
            return typeof value === "function" ? value.bind(current) : value;
          },
        });
        return callback(proxy);
      }, options);
    },
  });
}

function clientWithRetryBarrier(client: PrismaClient, reached: () => void, release: Promise<void>): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>,
        options?: Parameters<PrismaClient["$transaction"]>[1],
      ) => target.$transaction((transaction) => {
        const shop = new Proxy(transaction.shop, {
          get(delegate, method) {
            const original = Reflect.get(delegate, method, delegate);
            if (method !== "updateMany") return typeof original === "function" ? original.bind(delegate) : original;
            return async (args: Parameters<typeof transaction.shop.updateMany>[0]) => {
              const result = await Reflect.apply(original, delegate, [args]) as { count: number };
              if (args.data.status === undefined && args.data.reinstallPendingAt instanceof Date && result.count === 1) {
                reached();
                await release;
              }
              return result;
            };
          },
        });
        const proxy = new Proxy(transaction, {
          get(current, key) {
            if (key === "shop") return shop;
            const value = Reflect.get(current, key, current);
            return typeof value === "function" ? value.bind(current) : value;
          },
        });
        return callback(proxy);
      }, options);
    },
  });
}

describeWithPostgres("Shopify Session lifecycle PostgreSQL races", () => {
  beforeAll(async () => { fixture = await startLifecyclePostgres("credential races"); }, 240_000);
  afterAll(async () => { await fixture?.stop(); }, 60_000);

  it("returns authentication-required when Session persistence precedes committed uninstall", async () => {
    const db = requireFixture();
    const shop = await db.createShop("store-before-uninstall");
    const sessionId = `${shop.id}-old`;
    await db.storageSecond.storeSession(db.session(shop.domain, sessionId));
    await db.service(db.primary).markUninstalled(shop.domain, new Date());

    await expect(db.service(db.second).beginReinstallReconciliation(shop.id))
      .resolves.toEqual({ kind: "AUTHENTICATION_REQUIRED" });
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } }))
      .toMatchObject({ status: "UNINSTALLED", reinstallPendingAt: null });
    expect(await db.observer.subscription.findUnique({ where: { shopId: shop.id } })).toBeNull();
    expect(await db.storage.loadSession(sessionId)).toBeUndefined();
    expect(await db.second.session.updateMany({
      where: { id: sessionId, shop: shop.domain }, data: { scope: "read_products" },
    })).toMatchObject({ count: 0 });
  }, 30_000);

  it("schedules after uninstall when a new SDK offline Session is durably stored", async () => {
    const db = requireFixture();
    const shop = await db.createShop("uninstall-before-store");
    await db.storage.storeSession(db.session(shop.domain, `${shop.id}-old`));
    await db.service().markUninstalled(shop.domain, new Date());
    const replacementId = `${shop.id}-replacement`;
    await db.storageSecond.storeSession(db.session(shop.domain, replacementId, "replacement-token"));

    const result = await db.service(db.second).beginReinstallReconciliation(shop.id);
    expect(result.kind).toBe("SCHEDULED");
    expect(await db.storage.loadSession(replacementId)).toMatchObject({ accessToken: "replacement-token", isOnline: false });
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } })).toMatchObject({
      status: "UNINSTALLED",
      reinstallPendingAt: result.kind === "SCHEDULED" ? result.schedule.reinstallPendingAt : null,
    });
  }, 30_000);

  it("detects SDK persistence placed between the uninstall transition and atomic cleanup", async () => {
    const db = requireFixture();
    const shop = await db.createShop("store-during-uninstall");
    await db.storage.storeSession(db.session(shop.domain, `${shop.id}-initial`));
    const transitionReached = deferred<void>();
    const allowCleanup = deferred<void>();
    const deleting = db.service(clientWithTransitionBarrier(
      db.primary,
      () => transitionReached.resolve(),
      allowCleanup.promise,
    )).markUninstalled(shop.domain, new Date());

    await transitionReached.promise;
    const replacementId = `${shop.id}-interleaved`;
    await db.storageSecond.storeSession(db.session(shop.domain, replacementId, "interleaved-token"));
    allowCleanup.resolve();
    await deleting;

    expect(await db.storage.loadSession(replacementId)).toBeUndefined();
    await expect(db.service(db.second).beginReinstallReconciliation(shop.id))
      .resolves.toEqual({ kind: "AUTHENTICATION_REQUIRED" });
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } }))
      .toMatchObject({ status: "UNINSTALLED", reinstallPendingAt: null });
  }, 30_000);

  it("preserves replacement Sessions on duplicate delivery before and after begin admission", async () => {
    const db = requireFixture();
    const shop = await db.createShop("duplicate-with-replacement");
    const firstAt = new Date("2026-11-04T20:20:00.000Z");
    await db.service().markUninstalled(shop.domain, firstAt);
    const replacementId = `${shop.id}-replacement`;
    await db.storageSecond.storeSession(db.session(shop.domain, replacementId, "replacement-token"));
    await db.service().markUninstalled(shop.domain, new Date("2026-11-04T20:21:00.000Z"));
    expect(await db.storage.loadSession(replacementId)).toBeDefined();

    expect((await db.service(db.second).beginReinstallReconciliation(shop.id)).kind).toBe("SCHEDULED");
    await db.service().markUninstalled(shop.domain, new Date("2026-11-04T20:22:00.000Z"));
    expect(await db.storage.loadSession(replacementId)).toBeDefined();
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } }))
      .toMatchObject({ uninstalledAt: firstAt });
  }, 30_000);

  it("serializes simultaneous uninstall deliveries so only the winner deletes credentials", async () => {
    const db = requireFixture();
    const shop = await db.createShop("simultaneous-uninstall");
    await db.storage.storeSession(db.session(shop.domain, `${shop.id}-initial`));
    const start = deferred<void>();
    const deliveries = [db.service(db.primary), db.service(db.second)].map(async (service) => {
      await start.promise;
      return service.markUninstalled(shop.domain, new Date("2026-11-04T20:30:00.000Z"));
    });

    start.resolve();
    const results = await Promise.all(deliveries);
    expect(results.map((result) => result.kind).sort()).toEqual(["ALREADY_UNINSTALLED", "UNINSTALLED"]);
    const replacementId = `${shop.id}-replacement`;
    await db.storageSecond.storeSession(db.session(shop.domain, replacementId, "replacement-token"));
    await db.service().markUninstalled(shop.domain, new Date("2026-11-04T20:31:00.000Z"));
    expect(await db.storage.loadSession(replacementId)).toBeDefined();
  }, 30_000);

  it("commits scope persistence before uninstall when scope handling owns the Shop lock first", async () => {
    const db = requireFixture();
    const shop = await db.createShop("scopes-before-uninstall");
    const sessionId = `${shop.id}-offline`;
    await db.storage.storeSession(db.session(shop.domain, sessionId));
    const scopeUpdated = deferred<void>();
    const allowScopeCommit = deferred<void>();
    const scopeUpdate = db.primary.$transaction(async (transaction) => {
      const identity = await transaction.shop.findUniqueOrThrow({ where: { domain: shop.domain }, select: { id: true } });
      await lockShopLifecycleRow(transaction, identity.id);
      const result = await transaction.session.updateMany({
        where: { id: sessionId, shop: shop.domain },
        data: { scope: "read_products,read_discounts" },
      });
      scopeUpdated.resolve();
      await allowScopeCommit.promise;
      return result.count;
    });

    await scopeUpdated.promise;
    const uninstall = db.service(db.second).markUninstalled(shop.domain, new Date("2026-11-04T20:50:00.000Z"));
    allowScopeCommit.resolve();
    await expect(scopeUpdate).resolves.toBe(1);
    await expect(uninstall).resolves.toMatchObject({ kind: "UNINSTALLED" });
    expect(await db.storage.loadSession(sessionId)).toBeUndefined();
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } })).toMatchObject({ status: "UNINSTALLED" });
  }, 30_000);

  it("does not recreate a Session when uninstall commits before scope handling obtains the Shop lock", async () => {
    const db = requireFixture();
    const shop = await db.createShop("uninstall-before-scopes");
    const sessionId = `${shop.id}-offline`;
    await db.storage.storeSession(db.session(shop.domain, sessionId));
    await db.service(db.primary).markUninstalled(shop.domain, new Date("2026-11-04T20:51:00.000Z"));

    const updatedCount = await db.second.$transaction(async (transaction) => {
      const identity = await transaction.shop.findUniqueOrThrow({ where: { domain: shop.domain }, select: { id: true } });
      await lockShopLifecycleRow(transaction, identity.id);
      return (await transaction.session.updateMany({
        where: { id: sessionId, shop: shop.domain },
        data: { scope: "read_products" },
      })).count;
    });

    expect(updatedCount).toBe(0);
    expect(await db.storage.loadSession(sessionId)).toBeUndefined();
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } })).toMatchObject({ status: "UNINSTALLED" });
  }, 30_000);

  it("allows independent admission callers to converge on one committed schedule", async () => {
    const db = requireFixture();
    const shop = await db.createShop("concurrent-begin");
    await db.service().markUninstalled(shop.domain, new Date());
    await db.storage.storeSession(db.session(shop.domain, `${shop.id}-replacement`));
    const start = deferred<void>();
    const callers = [db.service(db.primary), db.service(db.second)].map(async (service) => {
      await start.promise;
      return service.beginReinstallReconciliation(shop.id);
    });

    start.resolve();
    const results = await Promise.all(callers);
    expect(results.map((result) => result.kind)).toEqual(["SCHEDULED", "SCHEDULED"]);
    if (results[0]?.kind !== "SCHEDULED" || results[1]?.kind !== "SCHEDULED") throw new Error("Expected schedules");
    expect(results[0].schedule).toEqual(results[1].schedule);
    expect(await db.observer.subscription.count({ where: { shopId: shop.id } })).toBe(1);
  }, 30_000);

  it("serializes begin against explicit retry while the retry transaction holds the Shop lock", async () => {
    const db = requireFixture();
    const shop = await db.createShop("begin-retry-race", "UNINSTALLED");
    const stoppedAt = new Date("2026-11-04T20:40:00.000Z");
    await db.primary.shop.update({ where: { id: shop.id }, data: { uninstalledAt: stoppedAt, reinstallPendingAt: stoppedAt } });
    await db.storage.storeSession(db.session(shop.domain, `${shop.id}-offline`));
    const retryReachedWrite = deferred<void>();
    const allowRetryCommit = deferred<void>();
    const retry = db.service(clientWithRetryBarrier(
      db.primary,
      () => retryReachedWrite.resolve(),
      allowRetryCommit.promise,
    )).retryReinstallReconciliation(shop.id, new Date("2026-11-04T20:41:00.000Z"));

    await retryReachedWrite.promise;
    const begin = db.service(db.second).beginReinstallReconciliation(shop.id);
    allowRetryCommit.resolve();
    const [retryResult, beginResult] = await Promise.all([retry, begin]);

    expect(retryResult.kind).toBe("SCHEDULED");
    expect(beginResult.kind).toBe("SCHEDULED");
    if (retryResult.kind !== "SCHEDULED" || beginResult.kind !== "SCHEDULED") throw new Error("Expected schedules");
    expect(beginResult.schedule).toEqual(retryResult.schedule);
    expect(await db.observer.subscription.count({ where: { shopId: shop.id } })).toBe(1);
  }, 30_000);
});
