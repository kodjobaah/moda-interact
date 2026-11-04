import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
vi.mock("../../app/db.server", () => ({ default: {} }));
import { saveMerchantRecoveryPolicy } from "../../app/services/recovery-policy/recovery-policy.server";
import { barrier, settingsPostgres, settingsShop, waitForShopLock } from "../helpers/merchant-settings-postgres";
let fixture: Awaited<ReturnType<typeof settingsPostgres>>;
const input = (ids: string[], notify = false) => ({ recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", selectedDiscountIds: ids, followUpEnabled: "false", followUpDelayMinutes: "", notifyOnInitialRecoveryOutreach: notify });
async function seed() {
 const shopId = await settingsShop(fixture.db);
 await fixture.db.shopSettings.update({ where: { shopId }, data: { recoveryDelayMinutes: 30 } });
 await fixture.db.shopifyDiscountCatalogue.create({ data: { shopId } });
 const ids = [randomUUID(), randomUUID(), randomUUID()];
 await fixture.db.shopifyDiscount.createMany({ data: ids.map((id, i) => ({ id, shopId, shopifyDiscountNodeId: "gid://shopify/Discount/" + id, providerType: "DiscountCodeBasic", method: "CODE", providerStatus: "EXPIRED", title: "Fixture", providerSnapshot: {}, lastSeenSyncGeneration: 1, lastSyncedAt: new Date(), isAvailable: i < 2 })) });
 return { shopId, ids };
}
const revision = async (shopId: string) => (await fixture.db.shopSettings.findUniqueOrThrow({ where: { shopId } })).updatedAt.toISOString();
describe.skipIf(process.env.MODA_SETTINGS_POSTGRES !== "1")("merchant policy physical writes", () => {
 beforeAll(async () => { fixture = await settingsPostgres(); }, 180000);
 afterAll(async () => { await fixture?.close(); }, 60000);
 it("true no-op keeps all timestamps and emits zero UPDATEs; settings-only leaves discount rows untouched", async () => {
  const { shopId, ids } = await seed();
  const before = await fixture.db.shopifyDiscount.findMany({ where: { shopId }, orderBy: { id: "asc" } });
  const old = await revision(shopId); fixture.sql.length = 0;
  const same = await saveMerchantRecoveryPolicy(shopId, input(ids.slice(0, 2)), old, fixture.db);
  expect(same.updatedAt.toISOString()).toBe(old);
  expect(fixture.sql.filter(q => /^UPDATE /i.test(q))).toHaveLength(0);
  expect(await fixture.db.shopifyDiscount.findMany({ where: { shopId }, orderBy: { id: "asc" } })).toEqual(before);
  fixture.sql.length = 0;
  await saveMerchantRecoveryPolicy(shopId, input(ids.slice(0, 2), true), old, fixture.db);
  expect(fixture.sql.filter(q => /^UPDATE .*ShopifyDiscount"/i.test(q))).toHaveLength(0);
  expect(fixture.sql.filter(q => /^UPDATE .*ShopSettings"/i.test(q))).toHaveLength(1);
  expect(await fixture.db.shopifyDiscount.findMany({ where: { shopId }, orderBy: { id: "asc" } })).toEqual(before);
 });
 it("updates added/removed IDs only; retained dormant selection timestamp stays unchanged and revision advances within a frozen millisecond", async () => {
  const { shopId, ids } = await seed();
  const before = await fixture.db.shopifyDiscount.findUniqueOrThrow({ where: { id: ids[1] } });
  const old = await revision(shopId);
  vi.spyOn(Date, "now").mockReturnValue(new Date(old).getTime()); fixture.sql.length = 0;
  try {
   const result = await saveMerchantRecoveryPolicy(shopId, input(ids.slice(1)), old, fixture.db);
   expect(result.updatedAt.getTime()).toBe(new Date(old).getTime() + 1);
  } finally { vi.restoreAllMocks(); }
  expect(await fixture.db.shopifyDiscount.findUniqueOrThrow({ where: { id: ids[1] } })).toEqual(before);
  expect((await fixture.db.shopifyDiscount.findMany({ where: { shopId, isAvailable: true } })).map(d => d.id).sort()).toEqual(ids.slice(1).sort());
  expect(fixture.sql.filter(q => /^UPDATE .*ShopifyDiscount"/i.test(q))).toHaveLength(2);
 });
 it("serializes two changed-state writers with one revision into one winner", async () => {
  const { shopId, ids } = await seed(); const old = await revision(shopId);
  const first = fixture.client(); const second = fixture.client(); const locked = barrier(); const release = barrier();
  const held = new Proxy(first, { get(target, key) {
   if (key !== "$transaction") { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; }
   return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async tx => {
    const proxy = new Proxy(tx, { get(t, k) { const value = Reflect.get(t, k); if (k === "$queryRaw") return async (...args: unknown[]) => { const result = await Reflect.apply(value, t, args); locked.resolve(); await release.promise; return result; }; return typeof value === "function" ? value.bind(t) : value; } });
    return run(proxy);
   }, { timeout: 20000 });
  } }) as PrismaClient;
  const winner = saveMerchantRecoveryPolicy(shopId, input([ids[0]], true), old, held);
  await locked.promise;
  const loser = saveMerchantRecoveryPolicy(shopId, input([ids[2]], true), old, second).then(value => ({ value }), error => ({ error }));
  try { await waitForShopLock(fixture.db); } finally { release.resolve(); }
  const won = await winner; const lost = await loser;
  expect(lost).toMatchObject({ error: { message: "CONFLICT" } });
  expect(await revision(shopId)).toBe(won.updatedAt.toISOString());
  expect((await fixture.db.shopifyDiscount.findMany({ where: { shopId, isAvailable: true } })).map(d => d.id)).toEqual([ids[0]]);
 });
 it("rolls back both deltas on a mismatched affected count", async () => {
  const { shopId, ids } = await seed(); const old = await revision(shopId);
  const client = new Proxy(fixture.db, { get(target, key) {
   if (key !== "$transaction") return Reflect.get(target, key);
   return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async tx => run(new Proxy(tx, { get(t, k) {
    if (k === "shopifyDiscount") return new Proxy(t.shopifyDiscount, { get(d, m) { const fn = Reflect.get(d, m); return m === "updateMany" ? async (args: Prisma.ShopifyDiscountUpdateManyArgs) => { await d.updateMany(args); return { count: 0 }; } : typeof fn === "function" ? fn.bind(d) : fn; } });
    const value = Reflect.get(t, k); return typeof value === "function" ? value.bind(t) : value;
   } })));
  } });
  await expect(saveMerchantRecoveryPolicy(shopId, input(ids.slice(1)), old, client)).rejects.toMatchObject({ code: "DISCOUNT_SELECTION_CHANGED" });
  expect(await revision(shopId)).toBe(old);
  expect((await fixture.db.shopifyDiscount.findMany({ where: { shopId, isAvailable: true } })).map(d => d.id).sort()).toEqual(ids.slice(0, 2).sort());
 });
});
