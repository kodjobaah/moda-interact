import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
vi.mock("../../app/db.server", () => ({ default: {} }));
import { selectPendingStoreCategory } from "../../app/services/store-profile/store-category-selection.server";
import { barrier, settingsPostgres, settingsShop, settingsCategory, waitForShopLock } from "../helpers/merchant-settings-postgres";
let fixture: Awaited<ReturnType<typeof settingsPostgres>>;
let categoryId: string;
async function publication(shopId: string) {
 return {
  profile: await fixture.db.commerceShopProfile.findUnique({ where: { shopId } }),
  prompts: await fixture.db.commerceAgentPrompt.findMany({ where: { shopId }, include: { revisions: true } }),
  configurations: await fixture.db.commerceAgentConfiguration.findMany({ where: { shopId } }),
 };
}
describe.skipIf(process.env.MODA_SETTINGS_POSTGRES !== "1")("category/lifecycle actual lock ordering", () => {
 beforeAll(async () => { fixture = await settingsPostgres(); categoryId = await settingsCategory(fixture.db); }, 180000);
 afterAll(async () => { await fixture?.close(); }, 60000);
 it("lifecycle lock wins first: denied category makes no partial profile, prompt or configuration writes", async () => {
  const shopId = await settingsShop(fixture.db); const before = await publication(shopId);
  const first = fixture.client(); const second = fixture.client(); const locked = barrier(); const release = barrier();
  const lifecycle = first.$transaction(async tx => {
   await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${shopId} FOR UPDATE`);
   await tx.shop.update({ where: { id: shopId }, data: { status: "SUSPENDED" } }); locked.resolve(); await release.promise;
  }, { timeout: 20000 });
  await locked.promise;
  const selection = selectPendingStoreCategory({ shopId, categoryId, expectedPendingSelectionGeneration: 0 }, second).then(value => ({ value }), error => ({ error }));
  try { await waitForShopLock(fixture.db); } finally { release.resolve(); }
  await lifecycle; expect(await selection).toMatchObject({ error: { code: "SHOP_UNAVAILABLE" } });
  expect(await publication(shopId)).toEqual(before);
 });
 it("category lock wins first: selection commits atomically before lifecycle writer proceeds", async () => {
  const shopId = await settingsShop(fixture.db); const first = fixture.client(); const second = fixture.client();
  const locked = barrier(); const release = barrier();
  const held = new Proxy(first, { get(target, key) {
   if (key !== "$transaction") { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; }
   return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async tx => run(new Proxy(tx, { get(t, k) {
    const value = Reflect.get(t, k);
    if (k === "$queryRaw") return async (...args: unknown[]) => { const result = await Reflect.apply(value, t, args); locked.resolve(); await release.promise; return result; };
    return typeof value === "function" ? value.bind(t) : value;
   } })), { timeout: 20000 });
  } }) as PrismaClient;
  const selection = selectPendingStoreCategory({ shopId, categoryId, expectedPendingSelectionGeneration: 0 }, held);
  await locked.promise;
  const lifecycle = second.shop.update({ where: { id: shopId }, data: { status: "SUSPENDED" } });
  // Start the lazy Prisma promise before observing its lock wait.
  const writing = lifecycle.then(value => value);
  try { await waitForShopLock(fixture.db); } finally { release.resolve(); }
  const selected = await selection; await writing;
  const state = await publication(shopId);
  expect(state.profile).toMatchObject({ pendingCategoryId: categoryId, pendingSelectionGeneration: 1, pendingPromptRevisionId: selected.pendingPromptRevisionId });
  expect(state.prompts).toHaveLength(1); expect(state.prompts[0].revisions).toHaveLength(1);
  expect(state.prompts[0].revisions[0]).toMatchObject({ status: "DRAFT", promptText: "Fixture prompt" });
  expect(state.configurations).toEqual([]);
  expect(await fixture.db.shop.findUnique({ where: { id: shopId } })).toMatchObject({ status: "SUSPENDED" });
 });
 it("missing Shop receives the same typed denial with no writes", async () => {
  await expect(selectPendingStoreCategory({ shopId: "missing-shop", categoryId, expectedPendingSelectionGeneration: 0 }, fixture.db)).rejects.toMatchObject({ code: "SHOP_UNAVAILABLE" });
  expect(await publication("missing-shop")).toEqual({ profile: null, prompts: [], configurations: [] });
 });
 it("rolls back profile and lineage writes when the database fails before creating the draft", async () => {
  const shopId = await settingsShop(fixture.db); const before = await publication(shopId);
  const client = new Proxy(fixture.db, { get(target, key) {
   if (key !== "$transaction") { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; }
   return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(tx => run(new Proxy(tx, { get(t, k) {
    if (k === "commerceAgentPromptRevision") return new Proxy(t.commerceAgentPromptRevision, { get(delegate, method) {
     if (method === "create") return async () => t.$executeRaw(Prisma.sql`SELECT * FROM "commerce"."missing_category_fixture_relation"`);
     const value = Reflect.get(delegate, method); return typeof value === "function" ? value.bind(delegate) : value;
    } });
    const value = Reflect.get(t, k); return typeof value === "function" ? value.bind(t) : value;
   } })));
  } }) as PrismaClient;
  await expect(selectPendingStoreCategory({ shopId, categoryId, expectedPendingSelectionGeneration: 0 }, client)).rejects.toMatchObject({ code: "P2010" });
  expect(await publication(shopId)).toEqual(before);
 });

});
