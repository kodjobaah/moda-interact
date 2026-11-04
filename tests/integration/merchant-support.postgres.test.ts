import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMerchantSupportPostgresFixture, type MerchantSupportPostgresFixture } from "../helpers/merchant-support-postgres";
import { composeMerchantMessage, markMerchantSupportMessagesRead, readMerchantSupportMessages, readMerchantSupportUnreadCount } from "../../app/services/merchant-support/merchant-support.service";
const suffix = randomUUID(); const shopId = `support-${suffix}`, foreignId = `foreign-${suffix}`;
const queries: string[] = [];
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
describe.skipIf(process.env.MODA_DISPOSABLE_INTEGRATION !== "1")("support on migrated PG17", () => {
  let fixture: MerchantSupportPostgresFixture; let db: PrismaClient;
  beforeAll(async () => {
    fixture = await startMerchantSupportPostgresFixture(); db = fixture.database;
    fixture.database.$on("query", e => queries.push(e.query));
    await db.shop.createMany({data: [{id: shopId, domain: `${shopId}.test`, defaultLanguageTag: "en"}, {id: foreignId, domain: `${foreignId}.test`}]});
  }, 240_000);
  beforeEach(async () => {
    await db.merchantSupportThread.deleteMany({where: {shopId: {in: [shopId, foreignId]}}});
    await db.shop.update({where: {id: shopId}, data: {defaultLanguageTag: "en"}});
  });
  afterAll(async () => { process.stdout.write(JSON.stringify({suite: "support", totalSqlIncludingFixtures: queries.length}) + "\n"); await fixture?.cleanup(); }, 60_000);
  async function seed() {
    const thread = await db.merchantSupportThread.create({data: {shopId}});
    const foreign = await db.merchantSupportThread.create({data: {shopId: foreignId}});
    for (const [id, kind, state, threadId] of [
      ["a", "ADMINISTRATIVE", "AVAILABLE", thread.id], ["b", "SYSTEM", "AVAILABLE", thread.id],
      ["unseen", "ADMINISTRATIVE", "AVAILABLE", thread.id], ["merchant", "MERCHANT", "AVAILABLE", thread.id],
      ["processing", "ADMINISTRATIVE", "PROCESSING", thread.id], ["foreign", "ADMINISTRATIVE", "AVAILABLE", foreign.id],
    ] as const) await db.merchantSupportMessage.create({data: {id: `${id}-${suffix}`, threadId, kind, state, originalBody: "Fixture", sourceLanguageTag: "en", displayLanguageTag: "fr", systemCode: kind === "SYSTEM" ? "FIXTURE" : null}});
    return thread;
  }
  it("uses one badge/two inbox SELECTs and preserves untranslated/system visibility", async () => {
    await seed(); let start = queries.length;
    expect(await readMerchantSupportUnreadCount({shopId, database: db})).toBe(3);
    const badge = queries.slice(start); expect(badge).toHaveLength(1); expect(badge[0]).not.toContain('"originalBody"');
    start = queries.length;
    const page = await readMerchantSupportMessages({shopId, database: db});
    const readQueries = queries.slice(start); expect(readQueries.filter(q => /^\s*SELECT/.test(q))).toHaveLength(2);
    expect(page.total).toBe(4); expect(page.unread).toBe(3);
    expect(page.items.find(m => m.kind === "SYSTEM")).toMatchObject({displayBody: null, originalBody: ""});
    process.stdout.write(JSON.stringify({operation: "inbox", selects: 2, transactionStatements: readQueries.filter(q => /^(BEGIN|COMMIT)/.test(q)).length, rows: page.items.length}) + "\n");
  });
  it("rejects mixed sets atomically and succeeds without rewriting already-read rows", async () => {
    await seed();
    for (const bad of ["foreign", "processing", "merchant", "missing"]) {
      expect(await markMerchantSupportMessagesRead({shopId, messageIds: [`a-${suffix}`, `${bad}-${suffix}`], database: db})).toEqual({marked: false});
      expect((await db.merchantSupportMessage.findUniqueOrThrow({where: {id: `a-${suffix}`}})).readAt).toBeNull();
    }
    const start = queries.length;
    expect(await markMerchantSupportMessagesRead({shopId, messageIds: [`a-${suffix}`, `b-${suffix}`], database: db})).toEqual({marked: true});
    const statements = queries.slice(start); expect(statements.filter(q => q.includes("WITH eligible"))).toHaveLength(1);
    const before = await db.merchantSupportMessage.findMany({where: {id: {in: [`a-${suffix}`, `b-${suffix}`]}}});
    expect(await markMerchantSupportMessagesRead({shopId, messageIds: [`a-${suffix}`, `b-${suffix}`], database: db})).toEqual({marked: true});
    expect(await db.merchantSupportMessage.findMany({where: {id: {in: [`a-${suffix}`, `b-${suffix}`]}}})).toEqual(before);
    expect((await db.merchantSupportMessage.findUniqueOrThrow({where: {id: `unseen-${suffix}`}})).readAt).toBeNull();
  });
  it("serializes overlapping batches and retains the first read timestamp", async () => {
    await seed(); const locked = barrier(), release = barrier();
    const firstClient = fixture.createClient("support-first"); const second = fixture.createClient("support-overlap");
    const first = firstClient.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "support"."MerchantSupportMessage" WHERE "id" = ${`a-${suffix}`} FOR UPDATE`);
      await tx.$executeRaw(Prisma.sql`UPDATE "support"."MerchantSupportMessage" SET "readAt" = '2026-11-01T00:00:00Z', "updatedAt" = '2026-11-01T00:00:00Z' WHERE "id" = ${`a-${suffix}`}`);
      locked.release(); await release.promise;
    }, {timeout: 30_000});
    await locked.promise;
    const overlap = markMerchantSupportMessagesRead({shopId, messageIds: [`a-${suffix}`, `b-${suffix}`], database: second});
    try {
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const result = await db.$queryRaw<Array<{waiting: boolean}>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = 'support-overlap' AND wait_event_type = 'Lock') AS waiting`);
        waiting = result[0].waiting;
      }
      expect(waiting).toBe(true);
    } finally { release.release(); }
    await first; expect(await overlap).toEqual({marked: true});
    const a = await db.merchantSupportMessage.findUniqueOrThrow({where: {id: `a-${suffix}`}});
    expect(a.readAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z"); expect(a.updatedAt).toEqual(a.readAt);
  });
  it("rolls back thread changes on insert failure and increments once per concurrent committed compose", async () => {
    await composeMerchantMessage({shopId, body: "First", database: db, queue: null});
    const original = await db.merchantSupportThread.findUniqueOrThrow({where: {shopId}});
    expect(original.merchantMessageVersion).toBe(1);
    const failing = new Proxy(db, {get(target, key) {
      if (key === "$transaction") return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(tx => callback(new Proxy(tx, {get(connection, method) {
        if (method === "$executeRaw") return async (query: Prisma.Sql) => { await connection.$executeRaw(query); throw new Error("injected after message insert"); };
        const value = Reflect.get(connection, method); return typeof value === "function" ? value.bind(connection) : value;
      }})));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    }});
    await expect(composeMerchantMessage({shopId, body: "Rollback", database: failing as never, queue: null})).rejects.toThrow("injected");
    expect(await db.merchantSupportThread.findUniqueOrThrow({where: {shopId}})).toEqual(original);
    const one = fixture.createClient("compose-one"), two = fixture.createClient("compose-two");
    let arrivals = 0; const both = barrier();
    const synchronized = (client: PrismaClient) => new Proxy(client, {get(target, key) {
      if (key === "$transaction") return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(tx => callback(new Proxy(tx, {get(connection, method) {
        if (method === "$queryRaw") return async (query: Prisma.Sql) => {
          const result = await connection.$queryRaw(query);
          if (query.sql.includes('FROM "commerce"."Shop"')) { if (++arrivals === 2) both.release(); await both.promise; }
          return result;
        };
        const value = Reflect.get(connection, method); return typeof value === "function" ? value.bind(connection) : value;
      }})), {timeout: 30_000});
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    }});
    await Promise.all([composeMerchantMessage({shopId, body: "One", database: synchronized(one) as never, queue: null}), composeMerchantMessage({shopId, body: "Two", database: synchronized(two) as never, queue: null})]);
    expect((await db.merchantSupportThread.findUniqueOrThrow({where: {shopId}})).merchantMessageVersion).toBe(3);
    expect(await db.merchantSupportMessage.count({where: {threadId: original.id}})).toBe(3);
    await db.shop.update({where: {id: shopId}, data: {defaultLanguageTag: "fr"}});
    const beforeTranslation = await db.merchantSupportThread.findUniqueOrThrow({where: {shopId}});
    let inserts = 0;
    const translationFailure = new Proxy(db, {get(target, key) {
      if (key === "$transaction") return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(tx => callback(new Proxy(tx, {get(connection, method) {
        if (method === "$executeRaw") return async (query: Prisma.Sql) => { const result = await connection.$executeRaw(query); if (++inserts === 2) throw new Error("translation insertion failure"); return result; };
        const value = Reflect.get(connection, method); return typeof value === "function" ? value.bind(connection) : value;
      }})));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    }});
    await expect(composeMerchantMessage({shopId, body: "Rollback translation", database: translationFailure as never, queue: null})).rejects.toThrow("translation insertion failure");
    expect(await db.merchantSupportThread.findUniqueOrThrow({where: {shopId}})).toEqual(beforeTranslation);
    expect(await db.merchantSupportMessage.count({where: {threadId: original.id}})).toBe(3);
    expect(await db.merchantMessageTranslation.count()).toBe(0);
    const result = await composeMerchantMessage({shopId, body: "Bonjour", database: db, queue: {add: async () => { throw new Error("synthetic queue failure"); }}});
    expect((await db.merchantMessageTranslation.findUniqueOrThrow({where: {id: result.translationId!}})).status).toBe("PENDING");
  });
});
