import { describe, expect, it, vi } from "vitest";
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
      const sql=query.mock.calls[0][0]; expect(sql.text).toContain('r."shopId" = $1 AND r."id" = $2'); expect(sql.values).toEqual([input.shopId,input.recoveryId]);
    }
  });
  it("does not expose internal recovery, provider, or unowned customer fields", async () => {
    const {db,query}=queued([{...owned, checkoutUrl:"secret", lineItems:{secret:true}, statusHistory:["internal"]}]);
    const dto=await readRecoveryDetail(input,db); expect(dto?.value.amount).toBe("1234567890123456.78");
    expect(dto).not.toHaveProperty("conversationId"); expect(dto).not.toHaveProperty("checkoutUrl"); expect(dto).not.toHaveProperty("statusHistory");
    expect(dto?.milestones).not.toHaveProperty("cancelledAt");
    expect(query.mock.calls[0][0].text).toContain('c."shopId" = r."shopId"');
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
    expect(query).toHaveBeenCalledTimes(3); const sql=query.mock.calls[1][0];expect(sql.text).toContain('LIMIT 51');expect(sql.text).not.toMatch(/JOIN|OFFSET/);expect(sql.values).toEqual([owned.conversationId]);
    expect(parseDetailNavigation(scope,{cursor:page?.nextCursor}).boundary).toEqual({at:date.toISOString(),id:"m-0050"});
  });
  it("first/next/previous/latest traverse >100 tied messages without duplicates",async()=>{
    const all=Array.from({length:125},(_,i)=>msg(i+1));
    const query=vi.fn(async (sql:Prisma.Sql)=>{
      if(sql.text.includes('LEFT JOIN')) return [owned];
      if(sql.text.includes('SELECT EXISTS')) return [{before:all.some(m=>m.id < String(sql.values[2])),after:all.some(m=>m.id > String(sql.values[5]))}];
      let rows=all.filter(m=>sql.values.length===1 || (sql.text.includes(') < (') ? m.id < String(sql.values[2]) : m.id > String(sql.values[2])));
      if(sql.text.includes('DESC')) rows=rows.slice().reverse(); return rows.slice(0,51);
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
    const sql=recoveryMessagePageSql("owned",{direction:"next",boundary:{at:date.toISOString(),id}});
    expect(sql.text).not.toContain(id);expect(sql.values).toContain(id);expect(sql.text).toContain('("createdAt", "id") >');
  });
});

describe("message content and delivery",()=>{
  it.each(["CUSTOMER","AGENT","AUTOMATION","HUMAN"])("keeps %s sender distinct from direction",senderType=>{
    const dto=recoveryMessageDto({...msg(1),senderType});expect(dto.sender).toBe(senderType);expect(dto.delivery).toBeNull();
  });
  it.each(["PENDING","SENT","DELIVERED","READ","FAILED"])("retains outbound %s and only recorded timestamps",status=>{
    const dto=recoveryMessageDto({...msg(1),direction:"OUTBOUND",status,sentAt:null});expect(dto.delivery?.status).toBe(status);expect(dto.delivery?.sentAt).toBeNull();
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
