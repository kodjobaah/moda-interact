import {AsyncLocalStorage} from "node:async_hooks";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {PrismaClient} from "@prisma/client";
import type {AdminApiContext} from "@shopify/shopify-app-react-router/server";
import {PostgreSqlContainer, type StartedPostgreSqlContainer} from "@testcontainers/postgresql";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {RouterContextProvider} from "react-router";

let database: ReturnType<typeof instrumentDatabase>;
let baseDatabase: PrismaClient;
const additionalClients: PrismaClient[] = [];
const clientScope = new AsyncLocalStorage<ReturnType<typeof instrumentDatabase>>();
let bootstrapReadBarrier: (() => Promise<void>) | undefined;
let container: StartedPostgreSqlContainer | undefined;
let admin: AdminApiContext;
let domain: string;
let breakBootstrap = false;
const sql: string[] = [];
const calls: string[] = [];
const provider = vi.fn();
vi.mock("../../app/db.server", () => ({default: new Proxy({}, {
  get(_target, key) {
    const value = Reflect.get(clientScope.getStore() ?? database, key);
    return typeof value === "function" ? value.bind(clientScope.getStore() ?? database) : value;
  },
})}));
vi.mock("../../app/shopify.server", () => ({authenticate: {admin: async () => ({admin, session: {shop: domain}})}}));
const {ShopService} = await import("../../app/services/shop/shop.service");
const {getMerchantRequestContext, merchantPageContextMiddleware} = await import("../../app/services/shop/merchant-request-context.server");
const enabled = process.env.MODA_MERCHANT_REQUEST_POSTGRES === "1";
const baseline = process.env.MODA_MERCHANT_REQUEST_BASELINE === "1";
const service = new ShopService();
function profile(locale = "en", id = "1") {
  return {data: {shop: {shopifyShopId: `gid://shopify/Shop/${id}`,
    myshopifyDomain: domain, ianaTimezone: "UTC", shopAddress: {countryCodeV2: "GB"}},
  shopLocales: [{locale, primary: true, published: true}]}};
}
function resetCounts() {sql.length = 0; calls.length = 0; provider.mockClear();}
function evidence(label: string) {
  const summary = {
    label, calls: [...calls], sql: [...sql],
    reads: sql.filter(text => /^SELECT/i.test(text)).length,
    writes: sql.filter(text => /^(INSERT|UPDATE|DELETE)/i.test(text)).length,
    transactionControl: sql.filter(text => /^(BEGIN|COMMIT|ROLLBACK)/i.test(text)).length,
    providerCalls: provider.mock.calls.length,
    relationExpansion: 0,
  };
  process.stdout.write(JSON.stringify({merchantRequestEvidence: summary}) + "\n");
  return summary;
}

function instrumentDatabase(client: PrismaClient) {
  return client.$extends({query: {$allModels: {async $allOperations({model, operation, args, query}) {
    calls.push(`${model}.${operation}`);
    const result = await query(args);
    if (bootstrapReadBarrier && model === "Shop" && operation === "findUnique" && result === null) {
      await bootstrapReadBarrier();
    }
    return result;
  }}, subscription: {upsert({args, query}) {
    if (breakBootstrap) Object.assign(args.create, {planId: "missing-plan-for-rollback"});
    return query(args);
  }}}});

}

describe.skipIf(!enabled)("canonical migrated merchant bootstrap", () => {
  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
        .withDatabase("moda_interact").withUsername("postgres")
        .withPassword(randomUUID()).start();
      const url = container.getConnectionUri();
      await promisify(execFile)(resolve("node_modules/.bin/prisma"), [
        "migrate", "deploy", "--schema", "database/prisma/schema.prisma",
      ], {env: {...process.env, DATABASE_URL: url}, timeout: 180_000});
      const client = new PrismaClient({datasourceUrl: url, log: [{emit: "event", level: "query"}]});
      client.$on("query", event => sql.push(event.query));
      baseDatabase = client;
      database = instrumentDatabase(client);
      await database.$connect();
      admin = {graphql: provider} as unknown as AdminApiContext;
      domain = "merchant-request-fixture.myshopify.com";
      provider.mockImplementation(async () => Response.json(profile()));
    } catch (error) {
      await baseDatabase?.$disconnect();
      await container?.stop();
      container = undefined;
      throw error;
    }
  }, 240_000);
  afterAll(async () => {
    try {await Promise.all([baseDatabase?.$disconnect(), ...additionalClients.map(client => client.$disconnect())]);} finally {await container?.stop();}
  });
  it("first install creates one Shop, scalar subscription and settings atomically", async () => {
    resetCounts();
    const shop = await service.resolveShopifyShop({admin, domain});
    expect(shop.domain).toBe(domain);
    const result = evidence(baseline ? "before-first-install" : "after-first-install");
    expect(result.providerCalls).toBe(1);
    expect(result.writes).toBeGreaterThan(0);
    expect(await database.subscription.count({where: {shopId: shop.id}})).toBe(1);
    expect(await database.shopSettings.count({where: {shopId: shop.id}})).toBe(1);
  });
  it("measures identical unchanged parent/child scalar composition", async () => {
    resetCounts();
    const outcomes = baseline
      ? await Promise.all([0, 1].map(async () => {
        const shop = await service.resolveShopifyShop({admin, domain});
        const subscription = await database.subscription.findUnique({where: {shopId: shop.id}});
        return {id: shop.id, status: subscription?.status};
      }))
      : await (async () => {
        const context = new RouterContextProvider();
        const request = new Request("https://app.test/app");
        await merchantPageContextMiddleware({request, context, params: {}, url: new URL(request.url), pattern: "/app"}, async () => undefined);
        return Promise.all([0, 1].map(async () => {
          const merchant = await getMerchantRequestContext({request, context});
          return {id: merchant.shop.id, status: (await merchant.readSubscription())?.status};
        }));
      })();
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0].status).toBe("NO_CONTRACT");
    const result = evidence(baseline ? "before-page" : "after-page");
    expect(result.writes).toBe(0);
    expect(result.providerCalls).toBe(baseline ? 2 : 1);
    expect(result.reads).toBe(baseline ? 4 : 3);
    expect(calls).toHaveLength(baseline ? 8 : 3);
  });
  it.skipIf(baseline)("direct established resource performs only demanded local scalar reads", async () => {
    resetCounts();
    const merchant = await getMerchantRequestContext({
      request: new Request("https://app.test/status"), context: new RouterContextProvider(),
    });
    await merchant.readSubscription();
    const result = evidence("after-direct-status");
    expect(result.providerCalls).toBe(0);
    expect(result.writes).toBe(0);
    expect(result.reads).toBe(2);
    expect(calls).not.toContain("ShopSettings.findUnique");
  });
  it("profile change updates only profile rows; unchanged replay performs no writes", async () => {
    provider.mockImplementation(async () => Response.json(profile("fr-CA")));
    resetCounts();
    const shop = await service.resolveShopifyShop({admin, domain});
    expect(shop.defaultLanguageTag).toBe("fr-CA");
    expect(calls).not.toContain("Subscription.upsert");
    expect(evidence("profile-change").writes).toBe(2);
    resetCounts();
    await service.resolveShopifyShop({admin, domain});
    expect(evidence("unchanged-replay").writes).toBe(0);
  });
  it.skipIf(baseline)("repairs both missing rows once across concurrent lazy callers", async () => {
    const shop = await database.shop.findUniqueOrThrow({where: {domain}});
    await database.subscription.delete({where: {shopId: shop.id}});
    await database.shopSettings.delete({where: {shopId: shop.id}});
    resetCounts();
    const merchant = await getMerchantRequestContext({
      request: new Request("https://app.test/status"), context: new RouterContextProvider(),
    });
    const [subscription, settings] = await Promise.all([merchant.readSubscription(), merchant.readSettings()]);
    expect(subscription?.shopId).toBe(shop.id);
    expect(settings?.shopId).toBe(shop.id);
    expect(provider).toHaveBeenCalledTimes(1);
    evidence("missing-row-repair");
  });
  it.skipIf(baseline)("concurrent independent bootstrap preserves unique identities", async () => {
    domain = "concurrent-request-fixture.myshopify.com";
    provider.mockImplementation(async () => Response.json(profile("en", "2")));
    // Both remote responses await an explicit barrier, rather than timing sleeps.
    let arrive!: () => void;
    const barrier = new Promise<void>(resolve => {arrive = resolve;});
    let arrivals = 0;
    provider.mockImplementation(async () => {
      if (++arrivals === 2) arrive();
      await barrier;
      return Response.json(profile("en", "2"));
    });
    let releaseReads!: () => void;
    const readsReady = new Promise<void>(resolve => {releaseReads = resolve;});
    let localReads = 0;
    bootstrapReadBarrier = async () => {
      if (++localReads === 2) releaseReads();
      await readsReady;
    };
    const url = new URL(container!.getConnectionUri());
    url.searchParams.set("connection_limit", "1");
    const clients = [0, 1].map(() => {
      const client = new PrismaClient({datasourceUrl: url.toString(), log: [{emit: "event", level: "query"}]});
      client.$on("query", event => sql.push(event.query));
      additionalClients.push(client);
      return instrumentDatabase(client);
    });
    try {
      const pids = await Promise.all(clients.map(client => client.$queryRaw<Array<{pid: number}>>`SELECT pg_backend_pid() AS pid`));
      expect(pids[0][0].pid).not.toBe(pids[1][0].pid);
      const shops = await Promise.all(clients.map(client =>
        clientScope.run(client, () => service.resolveShopifyShop({admin, domain}))));
      expect(localReads).toBe(2);
      expect(shops[0].id).toBe(shops[1].id);
      expect(await database.shop.count({where: {domain}})).toBe(1);
      expect(await database.subscription.count({where: {shopId: shops[0].id}})).toBe(1);
      expect(await database.shopSettings.count({where: {shopId: shops[0].id}})).toBe(1);
      process.stdout.write(JSON.stringify({bootstrapConcurrency: {distinctBackends: true, absentReads: localReads,
        shops: 1, subscriptions: 1, settings: 1}}) + "\n");
    } finally {bootstrapReadBarrier = undefined;}
  });
  it.skipIf(baseline)("database bootstrap failure rolls back Shop creation and retains Prisma code", async () => {
    domain = "rollback-request-fixture.myshopify.com";
    provider.mockImplementation(async () => Response.json(profile("en", "3")));
    breakBootstrap = true;
    resetCounts();
    try {
      await expect(service.resolveShopifyShop({admin, domain})).rejects.toMatchObject({code: "P2003"});
      expect(sql.some(text => /^ROLLBACK/.test(text))).toBe(true);
      expect(await database.shop.count({where: {domain}})).toBe(0);
    } finally {breakBootstrap = false;}
  });
});
