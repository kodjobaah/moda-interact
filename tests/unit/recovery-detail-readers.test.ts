import { readFileSync } from "node:fs";
import { loadRecoveryDetailSeed } from "../helpers/recovery-detail-seed.mjs";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
vi.mock("../../app/db.server", () => ({ default: {} }));
import { readRecoveryDetail, readRecoveryMessages, readRelatedRecoveries, recoveryMessagePageSql, type RecoveryDetailDatabase } from "../../app/services/recoveries/recovery-detail.server";
import { recoveryMessageDto, type RecoveryMessageRow } from "../../app/services/recoveries/detail-message";
import { detailCursor, detailCursorScope, parseDetailNavigation } from "../../app/services/recoveries/detail-cursor.server";

const input = { shopId: "shop-a", recoveryId: "recovery-a" };
const date = new Date("2026-09-01T00:00:00.000Z");
const owned = { id: input.recoveryId, customerId: "customer-a", conversationId: "conversation-a", firstName: "Ada", lastName: "L", email: "ada@example.invalid", status: "ENGAGED", totalPrice: new Prisma.Decimal("1234567890123456.78"), currency: "GBP", detectedAt: date, messageSentAt: null, engagedAt: date, completedAt: null, expiredAt: null };
const msg = (i: number): RecoveryMessageRow => ({ id: `m-${String(i).padStart(4,"0")}`, createdAt: date, direction: "INBOUND", senderType: "CUSTOMER", status: "DELIVERED", contentType: "TEXT", content: "مرحبا <script>alert(1)</script>", transcriptionStatus: "NOT_REQUIRED", sentAt: date, deliveredAt: date, readAt: date });
const scope = detailCursorScope(["messages", input.shopId, input.recoveryId]);
function queued(...results: unknown[]) {
  const query = vi.fn(); results.forEach(result => query.mockResolvedValueOnce(result));
  return { db: { $queryRaw: query } as RecoveryDetailDatabase, query };
}

describe("recovery detail ownership and projection", () => {
  it.each(["missing", "foreign"])("returns the same null for %s records and never reads messages", async () => {
    for (const reader of [readRecoveryDetail, readRecoveryMessages, readRelatedRecoveries]) {
      const {db,query}=queued([]); expect(await reader(input,db)).toBeNull(); expect(query).toHaveBeenCalledTimes(1);
      const sql=query.mock.calls[0][0]; expect(sql.text).toContain('r."shopId" = $2 AND r."id" = $3');
      expect(sql.values[0]).toBeInstanceOf(Date);
      expect(sql.values.slice(1)).toEqual([input.shopId,input.recoveryId]);
    }
  });
  it("does not expose internal recovery, provider, or unowned customer fields", async () => {
    const {db,query}=queued([{...owned, checkoutUrl:"secret", lineItems:{secret:true}, statusHistory:["internal"]}]);
    const dto=await readRecoveryDetail(input,db); expect(dto?.value.amount).toBe("1234567890123456.78");
    expect(dto).not.toHaveProperty("conversationId"); expect(dto).not.toHaveProperty("checkoutUrl"); expect(dto).not.toHaveProperty("statusHistory");
    expect(dto?.milestones).not.toHaveProperty("cancelledAt");
    expect(query.mock.calls[0][0].text).toContain('c."shopId" = r."shopId"');
  });
  it("projects initial outreach only from persisted send timestamps and keeps saved basket fields", async () => {
    const row = { ...owned, initialSentAt: date, lineItems: [{ title: "Saved product", variantTitle: "Large", quantity: 2, price: "12.34" }] };
    const dto = await readRecoveryDetail(input, queued([row]).db);
    expect(dto?.initialOutreachSentAt).toBe(date.toISOString());
    expect(dto?.basket.items[0]).toMatchObject({ title: "Saved product", variant: "Large", quantity: 2, unitPrice: "12.34" });
    const absent = await readRecoveryDetail(input, queued([{ ...row, initialSentAt: null }]).db);
    expect(absent?.initialOutreachSentAt).toBeNull();
  });
  it("handles unknown money, guests and no conversation without extra reads", async () => {
    const row={...owned,customerId:null,conversationId:null,totalPrice:null,currency:null};
    expect((await readRecoveryDetail(input,queued([row]).db))?.value).toEqual({amount:null,currency:null,incomplete:true});
    expect((await readRecoveryDetail(input,queued([row]).db))?.customer).toBeNull();
    for (const reader of [readRecoveryMessages,readRelatedRecoveries]) {
      const {db,query}=queued([row]); expect(await reader(input,db)).toEqual({items:[],previousCursor:null,nextCursor:null});expect(query).toHaveBeenCalledTimes(1);
    }
  });
});

describe("cursor validation",()=>{
  it.each(["", "!", "a".repeat(1025), null, 9, Buffer.from('{"v":2}').toString("base64url")])("rejects malformed cursor %s before reads",async cursor=>{
    const {db,query}=queued();await expect(readRecoveryMessages({...input,cursor},db)).rejects.toThrow("Invalid recovery detail query");expect(query).not.toHaveBeenCalled();
  });
  it("binds cursors to tenant, recovery and reader kind",async()=>{
    const cursor=detailCursor(scope,"next",{id:"m-0050",at:date.toISOString()});
    for(const args of [{...input,shopId:"shop-b"},{...input,recoveryId:"recovery-b"}]) await expect(readRecoveryMessages({...args,cursor},queued().db)).rejects.toThrow();
    await expect(readRelatedRecoveries({...input,cursor},queued().db)).rejects.toThrow();
    expect(parseDetailNavigation(scope,{cursor}).boundary?.id).toBe("m-0050");
  });
  it("rejects conflicting navigation, extra fields and invalid dates",()=>{
    const value={v:1,scope,direction:"next",at:date.toISOString(),id:"m-0050"};
    for(const bad of [{...value,at:"2026-02-30T00:00:00.000Z"},{...value,conversationId:"foreign"},{...value,id:""}]) expect(()=>parseDetailNavigation(scope,{cursor:Buffer.from(JSON.stringify(bad)).toString("base64url")})).toThrow();
    expect(()=>parseDetailNavigation(scope,{window:"arbitrary"})).toThrow();
    expect(()=>parseDetailNavigation(scope,{window:"latest",cursor:detailCursor(scope,"next",value)})).toThrow();
  });
});

describe("message pagination",()=>{
  it("takes 51, returns 50 and obtains constant-query edge cursors",async()=>{
    const {db,query}=queued([owned],Array.from({length:51},(_,i)=>msg(i+1)),[{before:false,after:true}]);
    const page=await readRecoveryMessages(input,db);expect(page?.items).toHaveLength(50);expect(page?.previousCursor).toBeNull();expect(page?.nextCursor).toBeTruthy();
    expect(query).toHaveBeenCalledTimes(3); const sql=query.mock.calls[1][0];expect(sql.text).toContain('UNION ALL');expect(sql.text).not.toMatch(/JOIN|OFFSET/);
    expect(sql.text).toContain('cmd."outboundMessageId" IS NULL');
    expect(sql.values).toEqual([owned.conversationId,input.shopId,owned.conversationId]);
    expect(parseDetailNavigation(scope,{cursor:page?.nextCursor}).boundary).toEqual({at:date.toISOString(),id:"m-0050"});
  });
  it("first/next/previous/latest traverse >100 tied messages without duplicates",async()=>{
    const all=Array.from({length:125},(_,i)=>msg(i+1));
    const query=vi.fn(async (sql:Prisma.Sql)=>{
      if(sql.text.includes('LEFT JOIN')) return [owned];
      if(sql.text.includes('AS "before"')) return [{before:all.some(m=>m.id < String(sql.values[2])),after:all.some(m=>m.id > String(sql.values[9]))}];
      // Parse the outer message-page ordering: the moderation subquery also has
      // an ORDER BY ... DESC, which must not reverse ordinary message pages.
      const pageOrder = /ORDER BY\s+"createdAt"\s+(ASC|DESC),\s+"id"\s+\1\s+LIMIT\s+51\s*$/u.exec(sql.text);
      if (!pageOrder) throw new Error("Expected outer message-page ordering");
      const keyset = /\(m\."createdAt",\s*m\."id"\)\s*([<>])\s*\(/u.exec(sql.text);
      const boundaryId = keyset ? sql.values.at(-1) : null;
      const rows = all.filter((message) => {
        if (!keyset) return true;
        if (typeof boundaryId !== "string") throw new Error("Missing bound pagination key");
        return keyset[1] === "<" ? message.id < boundaryId : message.id > boundaryId;
      });
      if (pageOrder[1] === "DESC") rows.reverse();
      return rows.slice(0, 51);
    });
    const db={$queryRaw:query} as RecoveryDetailDatabase;
    const first=(await readRecoveryMessages(input,db))!;
    const second=(await readRecoveryMessages({...input,cursor:first.nextCursor},db))!;
    const third=(await readRecoveryMessages({...input,cursor:second.nextCursor},db))!;
    expect([...first.items,...second.items,...third.items].map(m=>m.id)).toEqual(all.map(m=>m.id));
    const back=(await readRecoveryMessages({...input,cursor:second.previousCursor},db))!;expect(back.items).toEqual(first.items);
    const latest=(await readRecoveryMessages({...input,window:"latest"},db))!;expect(latest.items.map(m=>m.id)).toEqual(all.slice(-50).map(m=>m.id));
    // Deleting the boundary row does not invalidate original keyset coordinates.
    all.splice(49,1); const afterDelete=(await readRecoveryMessages({...input,cursor:first.nextCursor},db))!;
    expect(afterDelete.items[0].id).toBe("m-0051");
    all.push(msg(126));expect((await readRecoveryMessages({...input,cursor:first.nextCursor},db))?.items).toEqual(second.items);
  });
  it("parameterizes hostile key values and never derives authorization from a cursor",()=>{
    const id="x'; DROP TABLE t; --";
    const sql=recoveryMessagePageSql("shop-a","owned",{direction:"next",boundary:{at:date.toISOString(),id}});
    expect(sql.text).not.toContain(id);expect(sql.values).toContain(id);
    expect(sql.text).toContain('(m."createdAt", m."id") >');
    expect(sql.text).toContain('(cmd."createdAt", cmd."id") >');
  });
});

describe("merchant commands without provider messages", () => {
  const missingProviderMessage = (): RecoveryMessageRow => ({
    ...msg(2), id: "failed-command", createdAt: new Date("2026-10-20T12:14:00.000Z"),
    direction: "OUTBOUND", senderType: "HUMAN", status: null,
    contentType: "TEXT", content: "The unsent merchant reply", commandOnly: true,
    commandKind: "HUMAN_TEXT", humanCommandState: "FAILED",
    sentAt: null, deliveredAt: null, readAt: null,
  });

  it("includes the attempted reply and its terminal command status without claiming a provider receipt", async () => {
    const row = missingProviderMessage();
    const { db, query } = queued([owned], [msg(1), row], [{ before: false, after: false }]);
    const page = await readRecoveryMessages(input, db);
    expect(page?.items).toHaveLength(2);
    expect(page?.items[1]).toMatchObject({
      id: row.id, sender: "HUMAN", direction: "OUTBOUND",
      content: { text: "The unsent merchant reply" },
      delivery: { status: null, commandState: "FAILED", sentAt: null },
    });
    expect(query.mock.calls[1][0].text).toContain('cmd."outboundMessageId" IS NULL');
    expect(query.mock.calls[1][0].text).toContain('cmd."shopId"=');
    const edges = query.mock.calls[2][0];
    expect(edges.text).toContain('"MerchantConversationSendCommand"');
    expect(edges.text).toContain('"outboundMessageId" IS NULL');
    expect(edges.values).toContain(input.shopId);
  });

  it("preserves moderation cancellation and uncertainty without inventing delivery", () => {
    expect(recoveryMessageDto({ ...missingProviderMessage(), humanCommandState: "CANCELLED" })
      .delivery?.commandState).toBe("CANCELLED");
    expect(recoveryMessageDto({ ...missingProviderMessage(), humanCommandState: "UNKNOWN" })
      .delivery?.commandState).toBe("UNKNOWN");
    const template = recoveryMessageDto({ ...missingProviderMessage(), contentType: "UNSUPPORTED",
      content: null, commandKind: "RECOVERY_FOLLOW_UP_TEMPLATE", templateName: "cart_reminder" });
    expect(template.content.templateName).toBe("cart_reminder");
    expect(template.content.text).toBeNull();
    expect(recoveryMessageDto({ ...missingProviderMessage(), humanCommandState: "UNRECOGNIZED" })
      .delivery?.commandState).toBeNull();
  });
});

describe("message content and delivery",()=>{
  it.each(["CUSTOMER","AGENT","AUTOMATION","HUMAN"])("keeps %s sender distinct from direction",senderType=>{
    const dto=recoveryMessageDto({...msg(1),senderType});expect(dto.sender).toBe(senderType);expect(dto.delivery).toBeNull();
  });
  it.each(["PENDING","SENT","DELIVERED","READ","FAILED"])("retains outbound %s and only recorded timestamps",status=>{
    const dto=recoveryMessageDto({...msg(1),direction:"OUTBOUND",status,sentAt:null});expect(dto.delivery?.status).toBe(status);expect(dto.delivery?.sentAt).toBeNull();
  });
  it("marks only a HUMAN PENDING message with a linked UNKNOWN command as unconfirmed", () => {
    const human = { ...msg(1), direction: "OUTBOUND", senderType: "HUMAN", status: "PENDING", humanCommandState: "UNKNOWN" };
    const dto = recoveryMessageDto(human);
    expect(dto.delivery?.status).toBe("PENDING");
    expect(dto.delivery?.unconfirmed).toBe(true);
    for (const row of [
      { ...human, status: "SENT" }, { ...human, status: "DELIVERED" },
      { ...human, senderType: "AUTOMATION" }, { ...human, humanCommandState: "FAILED" },
      { ...human, humanCommandState: null },
    ]) expect(recoveryMessageDto(row).delivery?.unconfirmed).toBeUndefined();
  });
  it("reads command state only through a same-conversation, unique outbound-message link", () => {
    const sql = recoveryMessagePageSql("shop-a", "owned", { direction: "latest", boundary: null });
    expect(sql.text).toContain('cmd."outboundMessageId"=m."id"');
    expect(sql.text).toContain('cmd."conversationId"=m."conversationId"');
    expect(sql.text).toContain('cmd."state"::text');
    expect(sql.text).toContain("m.\"senderType\"='HUMAN'");
    expect(sql.values).toEqual(["owned", "shop-a", "owned"]);
  });
  it.each(["PENDING","REJECTED","FAILED","NOT_REQUIRED",null])("hides unsuccessful audio text for %s",transcriptionStatus=>{
    expect(recoveryMessageDto({...msg(1),contentType:"AUDIO",transcriptionStatus}).content.text).toBeNull();
  });
  it("preserves successful multilingual transcription and hides unsupported bodies",()=>{
    expect(recoveryMessageDto({...msg(1),contentType:"AUDIO",transcriptionStatus:"COMPLETED"}).content.text).toBe(msg(1).content);
    const dto=recoveryMessageDto({...msg(1),contentType:"UNSUPPORTED",senderType:"LEGACY",direction:"UNKNOWN",status:"UNKNOWN"});expect(dto.content.text).toBeNull();expect(dto.sender).toBeNull();expect(dto.direction).toBeNull();expect(dto.delivery).toBeNull();
    expect(recoveryMessageDto({...msg(1),direction:"OUTBOUND",status:"UNKNOWN"}).delivery?.status).toBeNull();
  });
});

describe("related recovery pages",()=>{
  it("uses owned customer and shop, excludes current, caps at five",async()=>{
    const rows=Array.from({length:6},(_,i)=>({...owned,id:`r-${6-i}`}));
    const {db,query}=queued([owned],rows,[{before:false,after:true}]);
    const page=await readRelatedRecoveries({...input,customerId:"foreign"} as typeof input,db);
    expect(page?.items).toHaveLength(5);expect(query).toHaveBeenCalledTimes(3);
    const sql=query.mock.calls[1][0];expect(sql.text).toContain('LIMIT 6');expect(sql.text).toContain('"id" <>');expect(sql.values).toEqual([input.shopId,owned.customerId,owned.id]);
    expect(page?.nextCursor).toBeTruthy();expect(page?.previousCursor).toBeNull();
  });
});


describe("PostgreSQL rehearsal UTC adapter", () => {
  it.each(["Europe/London", "America/New_York", "Asia/Kolkata"])("preserves persisted timestamp and bound Date in %s", (tz) => {
    // Separate processes guarantee host-zone behavior and avoid changing the test runner.
    const helper = new URL("../helpers/recovery-detail-pg-utc.mjs", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { recoveryDetailPgTypes, recoveryDetailPgValues } from ${JSON.stringify(helper)};
      import pg from "pg";
      import utils from "pg/lib/utils.js";
      const source = "2026-09-01 00:02:05.123";
      const parsed = recoveryDetailPgTypes.getTypeParser(1114)(source);
      const bound = recoveryDetailPgValues([new Date("2026-09-01T00:02:05.123Z"), "id", 51, null]);
      console.log(JSON.stringify({
        hostOffset: new Date("2026-09-01T00:00:00Z").getTimezoneOffset(),
        legacy: pg.types.getTypeParser(1114)(source).toISOString(),
        parsed: parsed.toISOString(), wire: utils.prepareValue(bound[0]), bound,
        boolean: recoveryDetailPgTypes.getTypeParser(16)("t"),
      }));
    `], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    const result = JSON.parse(output);
    expect(result.hostOffset).not.toBe(0);
    expect(result.legacy).not.toBe("2026-09-01T00:02:05.123Z");
    expect(result.parsed).toBe("2026-09-01T00:02:05.123Z");
    expect(result.wire).toBe("2026-09-01T00:02:05.123Z");
    expect(result.bound).toEqual(["2026-09-01T00:02:05.123Z", "id", 51, null]);
    expect(result.boolean).toBe(true);
  });
});


describe("database-owned psql recovery fixture loading", () => {
  const source = readFileSync(new URL("../../database/scripts/fixtures/arch019-recovery-indexes-seed.sql", import.meta.url), "utf8");
  it("passes the actual fixture's complete SQL unchanged without its client directive", async () => {
    const query = vi.fn().mockResolvedValue({});
    await loadRecoveryDetailSeed({ query }, source);
    expect(source.split("\n")[0]).toBe("\\set ON_ERROR_STOP on");
    expect(query).toHaveBeenCalledExactlyOnceWith(source.slice(source.indexOf("\n") + 1));
    expect(query.mock.calls[0][0]).not.toMatch(/^[\t ]*\\/m);
    expect(query.mock.calls[0][0]).toContain('CREATE TABLE public.arch019_indexes_before');
  });
  it("propagates PostgreSQL errors instead of proceeding with a partial seed", async () => {
    const error = new Error("seed SQL failed");
    const query = vi.fn().mockRejectedValue(error);
    await expect(loadRecoveryDetailSeed({ query }, source)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("fails closed if a future fixture introduces an unsupported psql directive", async () => {
    const query = vi.fn();
    await expect(loadRecoveryDetailSeed({ query }, source + "\n\\include other.sql\n")).rejects.toThrow("Unsupported psql directive");
    await expect(loadRecoveryDetailSeed({ query }, "SELECT 1;")).rejects.toThrow("Expected recovery seed");
    expect(query).not.toHaveBeenCalled();
  });
});


afterEach(() => vi.useRealTimers());

describe("ARCH-040-SHOPIFY-005 trusted Recovery Detail advisories", () => {
  const sent = new Date("2026-10-20T10:00:00.000Z");
  const now = new Date("2026-10-20T12:00:00.000Z");
  const due = new Date("2026-10-20T10:15:00.000Z");
  const base = { ...owned, initialSentAt: sent, followUpDueAt: due, followUpAvailable: true,
    followUpRecipient: "+447700900001", followUpUsed: false, approvedTemplateCount: 1,
    humanRestriction: null, lastCustomerInboundAt: null, controlMode: "HUMAN" };
  function read(row: object = base) { return readRecoveryDetail(input, queued([row]).db); }
  function clock(value = now) { vi.useFakeTimers(); vi.setSystemTime(value); }

  it("bounds the read query to provider-verified CUSTOMER messages since the initial send and no later than now", async () => {
    clock();
    const { db, query } = queued([base]);
    await readRecoveryDetail(input, db);
    const sql = query.mock.calls[0][0];
    expect(sql.text).toContain("m.\"direction\"='INBOUND'");
    expect(sql.text).toContain("m.\"senderType\"='CUSTOMER'");
    expect(sql.text).toContain('m."providerMessageId" IS NOT NULL');
    expect(sql.text).toContain('m."createdAt" >= initial."sentAt"');
    expect(sql.text).toContain('m."createdAt" <= $1::timestamp');
    expect(sql.text).toContain('ORDER BY m."createdAt" DESC, m."id" DESC LIMIT 1');
    expect(sql.text).toContain('initial."followUpDueAt" AS "followUpDueAt"');
    expect(sql.text).toContain('follow."claimedAt" IS NULL');
    expect(sql.values).toEqual([now, input.shopId, input.recoveryId]);
  });

  it("shows only the latest verified bounded inbound timestamp and rolls 24h from that reply", async () => {
    clock();
    const lastInbound = new Date(now.getTime() - 5_000);
    const detail = await read({ ...base, lastCustomerInboundAt: lastInbound });
    expect(detail?.conversation?.lastInboundAt).toBe(lastInbound.toISOString());
    expect(detail?.conversation?.windowExpiresAt).toBe(new Date(lastInbound.getTime() + 86_400_000).toISOString());
    expect(detail?.conversation?.followUp.eligible).toBe(false);
    for (const untrusted of [new Date(sent.getTime() - 1), new Date(now.getTime() + 1)]) {
      const denied = await read({ ...base, lastCustomerInboundAt: untrusted });
      expect(denied?.conversation?.lastInboundAt).toBeNull();
      expect(denied?.conversation?.windowExpiresAt).toBeNull();
    }
    const absent = await read({ ...base, initialSentAt: null, lastCustomerInboundAt: lastInbound });
    expect(absent?.conversation?.lastInboundAt).toBeNull();
    expect(absent?.conversation?.followUp.eligible).toBe(false);
  });

  it("closes the window at exact expiry so an already-due configured follow-up is advisory eligible", async () => {
    const oldInbound = new Date("2026-10-18T12:00:00.000Z");
    const oldSent = new Date("2026-10-18T10:00:00.000Z");
    // The configured follow-up must already be due when the 24-hour window expires.
    const dueAfterInitialSend = new Date(oldSent.getTime() + 15 * 60_000);
    const row = { ...base, initialSentAt: oldSent, followUpDueAt: dueAfterInitialSend,
      lastCustomerInboundAt: oldInbound };
    clock(new Date(oldInbound.getTime() + 86_400_000 - 1));
    const open = await read(row);
    expect(open?.conversation?.followUp.eligible).toBe(false);
    clock(new Date(oldInbound.getTime() + 86_400_000));
    const expired = await read(row);
    expect(expired?.conversation?.followUp.eligible).toBe(true);
  });

  it.each([
    ["15m already due", 15, 30, true],
    ["60m future", 60, 30, false],
    ["60m exact due", 60, 60, true],
    ["48h future", 48 * 60, 30, false],
    ["48h due", 48 * 60, 48 * 60, true],
  ])("uses the configured persisted deadline for %s", async (_, delay, elapsed, eligible) => {
    const start = new Date("2026-10-15T10:00:00.000Z");
    clock(new Date(start.getTime() + (elapsed as number) * 60_000));
    const result = await read({ ...base, initialSentAt: start,
      followUpDueAt: new Date(start.getTime() + (delay as number) * 60_000) });
    expect(result?.conversation?.followUp.eligible).toBe(eligible);
  });

  it("fails closed for unscheduled/disabled and initial-unsent outreach", async () => {
    clock();
    for (const row of [
      { ...base, followUpDueAt: null },
      { ...base, initialSentAt: null },
      { ...base, followUpAvailable: false, followUpUsed: true },
    ]) {
      const result = await read(row);
      expect(result?.conversation?.followUp.eligible).toBe(false);
    }
  });

  it("never offers a follow-up for terminal, suspended or invalid-recipient recovery", async () => {
    clock();
    for (const row of [
      { ...base, status: "COMPLETED" },
      { ...base, status: "CANCELLED" },
      { ...base, status: "EXPIRED" },
      { ...base, humanRestriction: "SUSPENDED" },
      { ...base, followUpRecipient: "not-a-number" },
    ]) {
      expect((await read(row))?.conversation?.followUp.eligible).toBe(false);
    }
  });

  it("preserves approved-template availability as a separate advisory field", async () => {
    clock();
    const result = await read({ ...base, approvedTemplateCount: 0 });
    expect(result?.conversation?.followUp).toMatchObject({ eligible: true, hasApprovedTemplate: false });
  });
});
