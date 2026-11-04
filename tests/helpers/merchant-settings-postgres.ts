import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
const exec = promisify(execFile);
export async function settingsPostgres() {
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
export async function settingsShop(db: PrismaClient) {
 const id = randomUUID();
 await db.shop.create({ data: { id, domain: id + ".myshopify.com", settings: { create: {} } } });
 return id;
}
export async function settingsCategory(db: PrismaClient) {
 const suffix = randomUUID();
 const admin = await db.platformAdmin.create({ data: { email: suffix + "@fixture.test", role: "SUPER_ADMIN", active: true } });
 const category = await db.commercePromptTemplateCategory.create({ data: { slug: "fixture-" + suffix, displayName: "Fixture", enabled: false, createdByAdminId: admin.id, updatedByAdminId: admin.id } });
 const template = await db.commercePromptTemplate.create({ data: { key: "template_" + suffix.replaceAll("-", "_"), categoryId: category.id, displayName: "Fixture", promptText: "Fixture prompt", enabled: true, createdByAdminId: admin.id, updatedByAdminId: admin.id } });
 await db.commercePromptTemplateCategory.update({ where: { id: category.id }, data: { enabled: true, defaultTemplateId: template.id } });
 return category.id;
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
