import { afterAll, beforeAll, expect, it, describe, vi } from "vitest";
vi.mock("../../app/db.server", () => ({default: {}}));
import {createWebPageSource, reorderMerchantKnowledgeSources, deleteMerchantKnowledgeSource} from "../../app/services/merchant-knowledge/merchant-knowledge.server";
import {knowledgePostgres, knowledgeTenant, barrier, holdFirstShopLock, waitForShopLock} from "../helpers/merchant-knowledge-postgres";
let f: Awaited<ReturnType<typeof knowledgePostgres>>;
describe.skipIf(process.env.MODA_DISPOSABLE_INTEGRATION !== "1")("knowledge ordering real locks", () => {
 beforeAll(async () => {f = await knowledgePostgres();}, 240000);
 afterAll(async () => {await f?.close();}, 60000);
 async function seed() {
  const {shopId} = await knowledgeTenant(f.db); const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await createWebPageSource({shopId, name: `Source ${i}`, purposeKey: "FAQ", dataFormatKey: "WEB_PAGE", url: `https://example.test/${i}`, database: f.db, queue: null})).sourceId);
  return {shopId, ids};
 }
 it("dense no-op emits zero UPDATEs; reorder has exactly two UPDATE statements and contiguous unique positions", async () => {
  const {shopId, ids} = await seed(); const before = await f.db.merchantKnowledgeSource.findMany({where: {shopId}, orderBy: {position: "asc"}}); f.sql.length = 0;
  await reorderMerchantKnowledgeSources({shopId, sourceIds: ids, database: f.db});
  expect(f.sql.filter(q => /^UPDATE/.test(q))).toHaveLength(0);
  expect(await f.db.merchantKnowledgeSource.findMany({where: {shopId}, orderBy: {position: "asc"}})).toEqual(before);
  const affectedRows: number[] = [];
  const measured = new Proxy(f.db, {get(target, key) {
   if (key === "$transaction") return (run: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(tx => run(new Proxy(tx, {get(connection, method) {
    if (method === "$executeRaw") return async (sql: import("@prisma/client").Prisma.Sql) => {const count = await connection.$executeRaw(sql); affectedRows.push(count); return count;};
    const value = Reflect.get(connection,method); return typeof value === "function" ? value.bind(connection) : value;
   }})));
   const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value;
  }});
  f.sql.length = 0; await reorderMerchantKnowledgeSources({shopId, sourceIds: [...ids].reverse(), database: measured as never});
  expect(affectedRows).toEqual([3, 3]);
  expect(f.sql.filter(q => /^\s*UPDATE/.test(q))).toHaveLength(2);
  expect((await f.db.merchantKnowledgeSource.findMany({where: {shopId}, orderBy: {position: "asc"}})).map(s => [s.id, s.position])).toEqual([...ids].reverse().map((id,i) => [id,i]));
  process.stdout.write(JSON.stringify({operation: "reorder", sourceCount: 3, orderingUpdates: 2, affectedRows, transactionStatements: f.sql.filter(q => /^(BEGIN|COMMIT)/.test(q)).length, providerCalls: 0}) + "\n");
 });
 it.each(["reorder", "delete-first", "delete-second"])("serializes %s ordering under the real Shop lock", async mode => {
  const {shopId, ids} = await seed(); const locked = barrier(), release = barrier();
  const held = holdFirstShopLock(f.client(), locked, release); const other = f.client();
  const first = mode === "delete-first" ? deleteMerchantKnowledgeSource({shopId, sourceId: ids[0], database: held}) : reorderMerchantKnowledgeSources({shopId, sourceIds: [...ids].reverse(), database: held});
  await locked.promise;
  const second = (mode === "delete-second" ? deleteMerchantKnowledgeSource({shopId, sourceId: ids[0], database: other}) : reorderMerchantKnowledgeSources({shopId, sourceIds: ids, database: other})).then(value => ({value}), error => ({error}));
  try {await waitForShopLock(f.db);} finally {release.resolve();}
  await first; const result = await second;
  if (mode === "delete-first") expect(result).toMatchObject({error: {code: "CONFLICT"}});
  else expect(result).toMatchObject({value: {ok: true}});
  const rows = await f.db.merchantKnowledgeSource.findMany({where: {shopId}, orderBy: {position: "asc"}});
  expect(rows.map(r => r.position)).toEqual(rows.map((_,i) => i)); expect(new Set(rows.map(r => r.id)).size).toBe(mode === "reorder" ? 3 : 2);
 });
 it("rejects foreign exact sets and rolls back a second-write failure", async () => {
  const {shopId, ids} = await seed(); const before = await f.db.merchantKnowledgeSource.findMany({where: {shopId}, orderBy: {position: "asc"}});
  await expect(reorderMerchantKnowledgeSources({shopId, sourceIds: ["foreign", ...ids.slice(1)], database: f.db})).rejects.toMatchObject({code: "CONFLICT"});
  const {Prisma} = await import("@prisma/client");
  const broken = new Proxy(f.db, {get(target, key) {
   if (key === "$transaction") return (run: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(tx => run(new Proxy(tx, {get(connection, method) {
    if (method === "$executeRaw") return async (sql: import("@prisma/client").Prisma.Sql) => {const count = await connection.$executeRaw(sql); if (sql.sql.includes("unnest")) await connection.$queryRaw(Prisma.sql`SELECT * FROM missing_knowledge_fixture`); return count;};
    const value = Reflect.get(connection, method); return typeof value === "function" ? value.bind(connection) : value;
   }})));
   const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value;
  }});
  await expect(reorderMerchantKnowledgeSources({shopId, sourceIds: [...ids].reverse(), database: broken as never})).rejects.toMatchObject({code: "P2010"});
  expect(await f.db.merchantKnowledgeSource.findMany({where: {shopId}, orderBy: {position: "asc"}})).toEqual(before);
 });
});
