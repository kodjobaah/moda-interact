import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBillingPostgresFixture, type BillingPostgresFixture } from "../helpers/billing-postgres";
import {ShopifyBillingOperationService} from "../../app/services/billing/shopify-billing-operation.service";
import { barrier, createPurchaseFixture, transactionPort } from "../fixtures/recovery-credit-purchases";

describe.skipIf(process.env.MODA_DISPOSABLE_INTEGRATION !== "1")("purchase admission on migrated PostgreSQL", () => {
  let fixture: BillingPostgresFixture;
  let sql = 0;
  beforeAll(async () => {
    fixture = await startBillingPostgresFixture();
    fixture.database.$on("query", () => { sql++; });
  }, 240_000);
  afterAll(async () => {
    process.stdout.write(JSON.stringify({ suite: "purchase_admission", emittedSql: sql }) + "\n");
    await fixture?.cleanup();
  }, 60_000);

  it.each([true, false])("admits one request when concurrent IDs are identical=%s", async sameId => {
    const data = await createPurchaseFixture(fixture.database, `race-${sameId}`);
    const gate = barrier(2);
    const ports = ["first", "second"].map(name => {
      const client = fixture.createClient(`purchase-${name}`);
      client.$on("query", () => { sql++; });
      return transactionPort(client, { before: () => gate.wait() });
    });
    const id = randomUUID();
    const pending = Promise.allSettled([
      data.request(data.service(ports[0]), id), data.request(data.service(ports[1]), sameId ? id : randomUUID()),
    ]);
    await gate.arrived;
    expect(data.lifecycle).toHaveBeenCalledTimes(4);
    expect(data.catalogueRead).toHaveBeenCalledTimes(4);
    gate.release();
    const results = await pending;
    expect(results.filter(result => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const purchases = await fixture.database.recoveryCreditPurchase.findMany({ where: { shopId: data.shopId } });
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ status: "REQUESTED", currentAmount: 0, reservedAmount: 0, version: 0 });
    expect(await fixture.database.usageEvent.count({ where: { shopId: data.shopId } })).toBe(1);
    const operations = await fixture.database.billingOperation.findMany({ where: { shopId: data.shopId } });
    expect(operations).toHaveLength(1);
    expect(operations[0].requestKey).toBe(`shopify:one-time-charge:${purchases[0].id}`);
    expect(Buffer.from(operations[0].requestFingerprint).toString("hex")).toBe(createHash("sha256").update(`shopify-billing-topup-v1\nONE_TIME_CHARGE\n${data.shopId}\n${operations[0].merchantPricingUsageEventId}\n500\nUSD\n`, "utf8").digest("hex"));
    const observations = data.lifecycle.mock.calls.length;
    await expect(data.request(data.service(), purchases[0].id)).resolves.toMatchObject({ id: purchases[0].id });
    expect(data.lifecycle).toHaveBeenCalledTimes(observations);
    expect(await fixture.database.recoveryCreditPurchase.count({where: {shopId: data.shopId}})).toBe(1);
    expect(await fixture.database.usageEvent.count({where: {shopId: data.shopId}})).toBe(1);
    expect(await fixture.database.billingOperation.count({where: {shopId: data.shopId}})).toBe(1);
    await expect(data.service().requestRecoveryCreditPack("foreign-tenant", "BUY_RECOVERY_CREDIT_PACK", purchases[0].id, data.eventHandle)).rejects.toThrow("belongs to another shop");
    await expect(fixture.database.$transaction(tx => new ShopifyBillingOperationService(fixture.database).recordOneTimeChargeIntent(tx, {
      shopId: data.shopId, purchaseId: purchases[0].id, providerQuantityBefore: 0,
      usageEvent: {id: operations[0].merchantPricingUsageEventId!, pricingMode: "FIXED", currency: "USD", fixedUnitAmountMinor: 501, tiers: []},
    }))).rejects.toThrow("idempotency conflict");
    expect(await fixture.database.billingOperation.findUniqueOrThrow({where: {id: operations[0].id}})).toMatchObject({quotedAmountMinor: 500, requestFingerprint: operations[0].requestFingerprint});
    expect(await fixture.database.recoveryCreditPurchase.count({where: {shopId: data.shopId}})).toBe(1);
  });

  it("rejects a cycle change committed after observations and before final admission", async () => {
    const data = await createPurchaseFixture(fixture.database, "cycle-change");
    const gate = barrier();
    const pending = data.request(data.service(transactionPort(fixture.database, { before: () => gate.wait() })));
    const rejection = expect(pending).rejects.toThrow("configuration changed");
    await gate.arrived;
    expect(data.lifecycle).toHaveBeenCalledTimes(2);
    expect(data.catalogueRead).toHaveBeenCalledTimes(2);
    const other = fixture.createClient("cycle-writer");
    await other.subscription.update({ where: { shopId: data.shopId }, data: { billingPeriodId: null } });
    gate.release();
    await rejection;
    expect(await fixture.database.recoveryCreditPurchase.count({ where: { shopId: data.shopId } })).toBe(0);
    expect(await fixture.database.usageEvent.count({ where: { shopId: data.shopId } })).toBe(0);
    expect(await fixture.database.billingOperation.count({ where: { shopId: data.shopId } })).toBe(0);
  });

  it.each(["usageEvent", "recoveryCreditPurchase", "billingOperation"])("rolls back every entity after the real %s write", async model => {
    const data = await createPurchaseFixture(fixture.database, `rollback-${model}`);
    const failure = new Error(`injected after ${model} persistence`);
    const port = transactionPort(fixture.database, { after: async (actual, method) => {
      if (actual === model && method === (model === "billingOperation" ? "upsert" : "create")) throw failure;
    } });
    await expect(data.request(data.service(port))).rejects.toBe(failure);
    for (const count of [
      fixture.database.recoveryCreditPurchase.count({ where: { shopId: data.shopId } }),
      fixture.database.usageEvent.count({ where: { shopId: data.shopId } }),
      fixture.database.billingOperation.count({ where: { shopId: data.shopId } }),
    ]) expect(await count).toBe(0);
    expect(data.lifecycle).toHaveBeenCalledTimes(2);
    expect(data.catalogueRead).toHaveBeenCalledTimes(2);
  });
});
