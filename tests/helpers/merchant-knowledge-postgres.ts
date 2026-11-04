import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
const exec = promisify(execFile);
export async function knowledgePostgres() {
 const postgres = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
 const url = postgres.getConnectionUri();
 const clients: PrismaClient[] = [];
 const sql: string[] = [];
 try {
  await exec(fileURLToPath(new URL("../../node_modules/.bin/prisma", import.meta.url)), ["migrate", "deploy", "--schema", "database/prisma/schema.prisma"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: { ...process.env, DATABASE_URL: url }, timeout: 180000 });
  const client = () => {
   const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] });
   db.$on("query", event => sql.push(event.query)); clients.push(db); return db;
  };
  const db = client();
  return { db, client, sql, async close() { try { await Promise.all(clients.map(c => c.$disconnect())); } finally { await postgres.stop(); } } };
 } catch (error) { await postgres.stop(); throw error; }
}
export async function knowledgeShop(db: PrismaClient) {
 const id = randomUUID();
 await db.shop.create({ data: { id, domain: id + ".myshopify.com", settings: { create: {} } } });
 return id;
}
export function barrier() {
 let resolve!: () => void;
 const promise = new Promise<void>(done => { resolve = done; });
 return { promise, resolve };
}
// Observer connection verifies a real lock wait, without sleeps or timing assumptions.
export async function waitForShopLock(db: PrismaClient) {
 for (let attempt = 0; attempt < 2000; attempt++) {
  const rows = await db.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS (
   SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
   AND wait_event_type = 'Lock' AND query LIKE '%commerce%Shop%'
  ) AS waiting`);
  if (rows[0]?.waiting) return;
 }
 throw new Error("Expected Shop lock waiter was not observed");
}

export async function knowledgeTenant(db: PrismaClient, maxKnowledgeSources = 5) {
 const shopId = await knowledgeShop(db);
 const feature = await db.feature.upsert({where: {key: "merchant_knowledge"}, update: {}, create: {key: "merchant_knowledge", displayName: "Knowledge", activationMode: "MERCHANT_OPT_IN", systemRequired: false}});
 const configuration = {schemaVersion: 1, maxKnowledgeSources, maxContentUnitsPerSource: 1000,
   allowedSourceTypes: [{purposeKey: "FAQ", dataFormatKey: "WEB_PAGE"}, {purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV"}]};
 const plan = await db.billingPlan.create({data: {shopifyPlanHandle: randomUUID(), name: "Knowledge fixture", kind: "FREE", features: {create: {featureId: feature.id, enabled: true, configuration}}}});
 await db.subscription.create({data: {shopId, planId: plan.id, status: "ACTIVE"}});
 for (const [purposeKey, formatKey, inputKind] of [["FAQ", "WEB_PAGE", "REMOTE_URL"], ["PRODUCT_INFORMATION", "CSV", "UPLOAD"]] as const) {
  const purpose = await db.merchantKnowledgePurpose.upsert({where: {key: purposeKey}, update: {}, create: {key: purposeKey, displayName: purposeKey}});
  const format = await db.merchantKnowledgeDataFormat.upsert({where: {key: formatKey}, update: {}, create: {key: formatKey, displayName: formatKey, inputKind, canonicalExtension: formatKey === "CSV" ? ".csv" : null, acceptedContentTypes: formatKey === "CSV" ? ["text/csv"] : []}});
  await db.merchantKnowledgePurposeDataFormat.upsert({where: {purposeId_dataFormatId: {purposeId: purpose.id, dataFormatId: format.id}}, update: {}, create: {purposeId: purpose.id, dataFormatId: format.id}});
 }
 return {shopId, featureId: feature.id};
}
export function holdFirstShopLock(client: PrismaClient, locked: ReturnType<typeof barrier>, release: ReturnType<typeof barrier>) {
 let first = true;
 return new Proxy(client, {get(target, key) {
  if (key === "$transaction") return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(tx => run(new Proxy(tx, {get(connection, method) {
   const value = Reflect.get(connection, method);
   if (method === "$queryRaw") return async (...args: unknown[]) => {
    const result = await Reflect.apply(value, connection, args);
    if (first) {first = false; locked.resolve(); await release.promise;}
    return result;
   };
   return typeof value === "function" ? value.bind(connection) : value;
  }})), {timeout: 30000});
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
 }}) as PrismaClient;
}
