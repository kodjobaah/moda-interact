import { loadRecoveryDetailSeed } from "../helpers/recovery-detail-seed.mjs";
import { readFile, readdir } from "node:fs/promises";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { Prisma } from "@prisma/client";
import { recoveryDetailPgTypes, recoveryDetailPgValues } from "../helpers/recovery-detail-pg-utc.mjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../../app/db.server", () => ({ default: {} }));
import { readRecoveryMessages, readRecoveryDetail, readRelatedRecoveries, recoveryMessagePageSql, type RecoveryDetailDatabase } from "../../app/services/recoveries/recovery-detail.server";

// Explicit opt-in: this command provisions its own disposable container only.
const enabled = process.env.MODA_RECOVERY_DETAIL_POSTGRES === "1";
let postgres: StartedPostgreSqlContainer | undefined;
let client: Client | undefined;
let db: RecoveryDetailDatabase;
const own = { shopId: "arch019-shop-1", recoveryId: "arch019-r-1-00001" };

describe.skipIf(!enabled)("recovery detail actual PostgreSQL queries", () => {
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:15-alpine").start();
    client = new Client({ connectionString: postgres.getConnectionUri(), types: recoveryDetailPgTypes });
    await client.connect();
    const migrations = new URL("../../database/prisma/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).sort()) {
      if (/^\d/.test(name)) await client.query(await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"));
    }
    await loadRecoveryDetailSeed(client, await readFile(new URL("../../database/scripts/fixtures/arch019-recovery-indexes-seed.sql", import.meta.url), "utf8"));
    await client.query('ANALYZE "whatsapp"."Conversation"');
    db = { async $queryRaw<T>(query: Prisma.Sql): Promise<T> { return (await client!.query(query.text, recoveryDetailPgValues(query.values))).rows as T; } };
    process.stdout.write(`POSTGRES_VERSION ${JSON.stringify((await client.query("SELECT version()")).rows)}\n`);
  }, 180_000);
  afterAll(async () => { try { await client?.end(); } finally { await postgres?.stop(); } }, 60_000);

  it("pages actual owned conversations and denies foreign/missing IDs", async () => {
    expect(await readRecoveryDetail({...own,shopId:"arch019-shop-2"},db)).toBeNull();
    expect(await readRecoveryMessages({...own,recoveryId:"missing"},db)).toBeNull();
    const first=(await readRecoveryMessages(own,db))!;
    expect(first.items).toHaveLength(50);expect(first.previousCursor).toBeNull();
    expect(first.items[0].createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(first.items[49].createdAt).toBe("2026-09-01T00:00:12.000Z");
    const second=(await readRecoveryMessages({...own,cursor:first.nextCursor},db))!;
    const back=(await readRecoveryMessages({...own,cursor:second.previousCursor},db))!;
    expect(back.items).toEqual(first.items);
    expect(new Set([...first.items,...second.items].map(m=>m.id)).size).toBe(100);
    const latest=(await readRecoveryMessages({...own,window:"latest"},db))!;
    expect(latest.items.at(-1)?.id).toBe("arch019-m-1-00001-1000");expect(latest.nextCursor).toBeNull();
    const related=(await readRelatedRecoveries(own,db))!;expect(related.items).toHaveLength(5);
    expect(related.items.every(r=>r.id.startsWith("arch019-r-1-")&&r.id!==own.recoveryId)).toBe(true);
  });

  it.each(["first","next","previous","latest"] as const)("%s message plan bounds traversal to 51 rows without sort/join",async direction=>{
    const query=recoveryMessagePageSql("arch019-conv-1-00001",{direction,boundary:direction==="next"||direction==="previous" ? {id:"arch019-m-1-00001-0500",at:"2026-09-01T00:02:05.000Z"}:null});
    const result=await client!.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,recoveryDetailPgValues(query.values));
    const plan=result.rows[0]["QUERY PLAN"][0];process.stdout.write(`RECOVERY_MESSAGE_PLAN ${direction} ${JSON.stringify(plan)}\n`);
    const nodes: Record<string,unknown>[]=[];
    function visit(node: Record<string,unknown>) {nodes.push(node);for(const child of (node.Plans??[]) as Record<string,unknown>[])visit(child);}
    visit(plan.Plan);
    expect(nodes.some(n=>String(n["Node Type"]).includes("Sort")||String(n["Node Type"]).includes("Join"))).toBe(false);
    const scans=nodes.filter(n=>String(n["Node Type"]).includes("Scan"));expect(scans).toHaveLength(1);
    expect(scans[0]["Index Name"]).toBe("ConversationMessage_conversationId_createdAt_id_idx");
    expect(Number(scans[0]["Actual Rows"])).toBeLessThanOrEqual(51);
    expect(Number(scans[0]["Actual Rows"])).toBeGreaterThan(0);
  });
});
