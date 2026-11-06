import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
vi.mock("../../app/db.server", () => ({default: {}}));
import {createMerchantKnowledgeUploadIntent, finalizeMerchantKnowledgeUpload} from "../../app/services/merchant-knowledge/upload.server";
import {knowledgePostgres, knowledgeTenant, barrier, holdFirstShopLock, waitForShopLock} from "../helpers/merchant-knowledge-postgres";
let f: Awaited<ReturnType<typeof knowledgePostgres>>;
const config = {endpoint: "https://fixture.r2.example", bucket: "fixture-bucket", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", region: "auto" as const, maxUploadBytes: 1000, maxXlsxUncompressedBytes: 2000};
const r2 = {signPut: async () => "https://fixture.example/upload", headObject: async () => ({contentLength: 10, contentType: "text/csv"})};
describe.skipIf(process.env.MODA_DISPOSABLE_INTEGRATION !== "1")("knowledge finalization real transactions", () => {
 beforeAll(async () => {f = await knowledgePostgres();}, 240000);
 afterAll(async () => {await f?.close();}, 60000);
 async function intent(shopId: string) {
  return createMerchantKnowledgeUploadIntent({shopId, purposeKey: "PRODUCT_INFORMATION", dataFormatKey: "CSV", originalFileName: "fixture.csv", contentType: "text/csv", sizeBytes: 10, database: f.db, config, r2});
 }
 function input(shopId: string, assetId: string) { return {shopId, assetId, purposeKey: "PRODUCT_INFORMATION", name: "Fixture", languageTag: "en", sizeBytes: 10, sha256: "a".repeat(64), contentType: "text/csv", config, r2, queue: null}; }
 it("two separate finalizations have one committed source/revision and one existing conflict", async () => {
  const {shopId} = await knowledgeTenant(f.db); const asset = await intent(shopId); const locked = barrier(), release = barrier();
  const first = finalizeMerchantKnowledgeUpload({...input(shopId, asset.assetId), database: holdFirstShopLock(f.client(), locked, release)});
  await locked.promise;
  const second = finalizeMerchantKnowledgeUpload({...input(shopId, asset.assetId), database: f.client()}).then(value => ({value}), error => ({error}));
  try {await waitForShopLock(f.db);} finally {release.resolve();}
  await first; expect(await second).toMatchObject({error: {code: "CONFLICT"}});
  expect(await f.db.merchantKnowledgeSource.count({where: {shopId}})).toBe(1);
  expect(await f.db.merchantKnowledgeSourceRevision.count({where: {source: {shopId}}})).toBe(1);
 });
 it.each(["inactive", "count"])("%s admission denial retains pending asset with no partial source/revision", async reason => {
  const {shopId} = await knowledgeTenant(f.db, 1);
  if (reason === "count") {const first = await intent(shopId); await finalizeMerchantKnowledgeUpload({...input(shopId, first.assetId), database: f.db});}
  const asset = await intent(shopId);
  if (reason === "inactive") await f.db.shop.update({where: {id: shopId}, data: {status: "SUSPENDED"}});
  await expect(finalizeMerchantKnowledgeUpload({...input(shopId, asset.assetId), database: f.db})).rejects.toMatchObject({code: "DENIED"});
  expect((await f.db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({where: {id: asset.assetId}})).status).toBe("PENDING_UPLOAD");
  expect(await f.db.merchantKnowledgeSource.count({where: {shopId}})).toBe(reason === "count" ? 1 : 0);
 });
 it.each(["activation", "queue"])("postcommit %s failure retains durable pending work and queued:false", async stage => {
  const {shopId, featureId} = await knowledgeTenant(f.db); const asset = await intent(shopId);
  await f.db.shopFeaturePreference.create({data: {shopId, featureId, enabled: true}});
  const database = new Proxy(f.db, {get(target, key) {
   if (stage === "activation" && key === "feature") return {findUnique: async () => {throw Object.assign(new Error("original activation failure"), {code: "P1001"});}};
   const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value;
  }});
  const result = await finalizeMerchantKnowledgeUpload({...input(shopId, asset.assetId), database, queue: {add: async () => {throw new Error("original queue failure");}}});
  expect(result.queued).toBe(false);
  expect((await f.db.merchantKnowledgeUploadedAsset.findUniqueOrThrow({where: {id: asset.assetId}})).status).toBe("AVAILABLE");
  expect(await f.db.merchantKnowledgeSourceRevision.findMany({where: {sourceId: result.sourceId}})).toMatchObject([{status: "PENDING"}]);
 });
});
