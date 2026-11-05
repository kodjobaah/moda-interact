import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLifecyclePostgres, type LifecyclePostgres } from "../helpers/shopify-lifecycle-postgres";

const enabled = process.env.MODA_SHOPIFY_LIFECYCLE_POSTGRES === "1";
const describeWithPostgres = enabled ? describe : describe.skip;
let fixture: LifecyclePostgres | undefined;

function requireFixture() {
  if (!fixture) throw new Error("Shopify lifecycle PostgreSQL fixture is unavailable");
  return fixture;
}

function clientWithDeleteFailure(client: PrismaClient): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>,
        options?: Parameters<PrismaClient["$transaction"]>[1],
      ) => target.$transaction((transaction) => {
        const session = new Proxy(transaction.session, {
          get(delegate, method) {
            if (method === "deleteMany") return async (args: Parameters<typeof transaction.session.deleteMany>[0]) => {
              await Reflect.apply(Reflect.get(delegate, method, delegate), delegate, [args]);
              throw new Error("injected post-delete cleanup failure");
            };
            const value = Reflect.get(delegate, method, delegate);
            return typeof value === "function" ? value.bind(delegate) : value;
          },
        });
        const proxy = new Proxy(transaction, {
          get(current, key) {
            if (key === "session") return session;
            const value = Reflect.get(current, key, current);
            return typeof value === "function" ? value.bind(current) : value;
          },
        });
        return callback(proxy);
      }, options);
    },
  });
}

describeWithPostgres("Shopify Session lifecycle PostgreSQL transaction guarantees", () => {
  beforeAll(async () => { fixture = await startLifecyclePostgres("transaction guarantees"); }, 240_000);
  afterAll(async () => { await fixture?.stop(); }, 60_000);

  it("rolls back the Shop transition when transaction-owned Session deletion fails", async () => {
    const db = requireFixture();
    const shop = await db.createShop("rollback");
    await db.storage.storeSession(db.session(shop.domain, `${shop.id}-old`));

    await expect(db.service(clientWithDeleteFailure(db.primary)).markUninstalled(
      shop.domain, new Date("2026-11-04T20:00:00.000Z"),
    )).rejects.toThrow("injected post-delete cleanup failure");

    const durableShop = await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(durableShop).toMatchObject({ status: "ACTIVE", uninstalledAt: null, reinstallPendingAt: null });
    expect(await db.storage.loadSession(`${shop.id}-old`)).toBeDefined();

    await db.service().markUninstalled(shop.domain, new Date("2026-11-04T20:01:00.000Z"));
    expect((await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } })).status).toBe("UNINSTALLED");
    expect(await db.storage.loadSession(`${shop.id}-old`)).toBeUndefined();
  }, 30_000);

  it("preserves replacement credentials, the first timestamp, and reinstall marker on duplicate delivery", async () => {
    const db = requireFixture();
    const shop = await db.createShop("duplicate");
    const firstAt = new Date("2026-11-04T20:10:00.000Z");
    await db.service().markUninstalled(shop.domain, firstAt);
    await db.storage.storeSession(db.session(shop.domain, `${shop.id}-replacement`, "replacement-token"));
    const pendingAt = new Date("2026-11-04T20:11:00.000Z");
    await db.primary.shop.update({ where: { id: shop.id }, data: { reinstallPendingAt: pendingAt } });

    await expect(db.service().markUninstalled(shop.domain, new Date("2026-11-04T20:12:00.000Z")))
      .resolves.toMatchObject({ kind: "ALREADY_UNINSTALLED", shopId: shop.id });
    expect(await db.storage.loadSession(`${shop.id}-replacement`)).toMatchObject({ accessToken: "replacement-token" });
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } }))
      .toMatchObject({ uninstalledAt: firstAt, reinstallPendingAt: pendingAt });
  }, 30_000);

  it("deletes only the target tenant credentials and leaves an orphan credential untouched", async () => {
    const db = requireFixture();
    const target = await db.createShop("tenant-a");
    const control = await db.createShop("tenant-b");
    await db.storage.storeSession(db.session(target.domain, `${target.id}-session`));
    await db.storage.storeSession(db.session(control.domain, `${control.id}-session`));
    const orphan = "orphan.myshopify.com";
    await db.storage.storeSession(db.session(orphan, `${db.prefix}-orphan-session`));

    await expect(db.service().markUninstalled("  " + target.domain.toUpperCase() + "  ", new Date()))
      .resolves.toMatchObject({ kind: "UNINSTALLED", shopId: target.id });
    expect(await db.storage.loadSession(`${target.id}-session`)).toBeUndefined();
    expect(await db.storage.loadSession(`${control.id}-session`)).toBeDefined();
    expect(await db.storage.loadSession(`${db.prefix}-orphan-session`)).toBeDefined();
    await expect(db.service().markUninstalled(orphan, new Date()))
      .resolves.toEqual({ kind: "SHOP_NOT_FOUND" });
    expect(await db.storage.loadSession(`${db.prefix}-orphan-session`)).toBeDefined();
  }, 30_000);
});
