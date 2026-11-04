import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBillingPostgresFixture, type BillingPostgresFixture } from "../helpers/billing-postgres";
import { createRefundFixture } from "../fixtures/recovery-credit-refunds";
import { barrier, transactionPort } from "../fixtures/recovery-credit-purchases";

describe.skipIf(process.env.MODA_DISPOSABLE_INTEGRATION !== "1")("refund admission on migrated PostgreSQL", () => {
  let fixture: BillingPostgresFixture;
  let sql = 0;
  const queries: string[] = [];
  beforeAll(async () => {
    fixture = await startBillingPostgresFixture();
    fixture.database.$on("query", event => { sql++; queries.push(event.query); });
  }, 240_000);
  afterAll(async () => {
    process.stdout.write(JSON.stringify({ suite: "refund_admission", emittedSql: sql }) + "\n");
    await fixture?.cleanup();
  }, 60_000);

  it.each([1, 5, 20])("measures emitted history SQL separately for %i visible rows", async count => {
    const data = await createRefundFixture(fixture.database, `history-${count}`);
    for (let index = 1; index < count; index++) {
      const usage = await fixture.database.usageEvent.create({ data: {
        shopId: data.shopId, billingPeriodId: data.period.id, metric: "RECOVERY_CREDIT_PACK_PURCHASE", quantity: 1,
        idempotencyKey: randomUUID(), sourceType: "RECOVERY_CREDIT_PURCHASE", sourceId: randomUUID(),
      } });
      await fixture.database.recoveryCreditPurchase.create({ data: {
        ...data.purchase, id: randomUUID(), usageEventId: usage.id,
        providerPriceSnapshot: { kind: "FIXED", amount: "5.00", currency: "USD" },
      } });
    }
    await fixture.database.shopEntitlementCounter.update({ where: { id: data.counter.id }, data: { grantedQuantity: count * 10 } });
    const offset = queries.length;
    const page = await data.service().listPurchaseHistory({ shopId: data.shopId, shopifyShopId: data.input.shopifyShopId, pageSize: count });
    const emitted = queries.slice(offset);
    process.stdout.write(JSON.stringify({ operation: "history", rows: count, emittedSql: emitted.length,
      selectStatements: emitted.filter(query => /^SELECT\b/i.test(query)).length,
      transactionControl: emitted.filter(query => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(query)).length,
      providerRequests: data.active.mock.calls.length, returnedRows: page.purchases.length,
    }) + "\n");
    expect(page.purchases).toHaveLength(count);
    expect(page.purchases.every(row => row.refundEligible)).toBe(true);
    expect(data.active).toHaveBeenCalledTimes(1);
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("admits one hold for two requests with provider evidence outside both transactions", async () => {
    const data = await createRefundFixture(fixture.database, "two-refunds");
    const gate = barrier(2);
    let open = 0;
    data.active.mockImplementation(async () => { expect(open).toBe(0); return data.providerSubscription; });
    const services = ["one", "two"].map(name => {
      const connection = fixture.createClient(`refund-${name}`);
      connection.$on("query", () => { sql++; });
      return data.service(transactionPort(connection, {
        before: () => gate.wait(), open: value => { open += value ? 1 : -1; },
      }));
    });
    const pending = Promise.all(services.map(service => service.requestRefund({ ...data.input, requestId: randomUUID() })));
    await gate.arrived;
    expect(data.active).toHaveBeenCalledTimes(2);
    gate.release();
    const outcomes = await pending;
    expect(outcomes.every(result => result.code === "REQUESTED" || result.code === "ALREADY_WITHDRAWN")).toBe(true);
    const state = await data.state();
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0].requestKey).toContain(`merchant-ui:recovery-credit-refund:${data.shopId}:`);
    expect(state.purchase).toMatchObject({ status: "WITHDRAWN", currentAmount: 10, reservedAmount: 0, version: 1 });
    expect(state.counter).toMatchObject({ refundingQuantity: 10, reservedQuantity: 0, version: 1 });
  });

  it("retries with fresh evidence after a concurrent reservation changes versions before CAS", async () => {
    const data = await createRefundFixture(fixture.database, "reservation");
    const gate = barrier();
    let paused = false;
    let observations = 0;
    data.active.mockImplementation(async () => { observations++; return data.providerSubscription; });
    const port = transactionPort(fixture.database, { beforeMethod: async (model, method) => {
      if (!paused && model === "recoveryCreditRefund" && method === "create") { paused = true; await gate.wait(); }
    } });
    let sinkCalls = 0;
    const diagnostics = createLogger({ serviceName: "moda-interact", environment: "test", sink: () => {
      sinkCalls++; throw new Error("isolated Shared sink failure");
    } });
    const pending = data.service(port, diagnostics).requestRefund(data.input);
    await gate.arrived;
    const writer = fixture.createClient("reservation-writer");
    await writer.$transaction(async tx => {
      await tx.recoveryCreditPurchase.update({ where: { id: data.purchase.id }, data: { reservedAmount: 3, version: { increment: 1 } } });
      await tx.shopEntitlementCounter.update({ where: { id: data.counter.id }, data: { reservedQuantity: 3, version: { increment: 1 } } });
      await tx.usageReservation.create({ data: { shopId: data.shopId, counterId: data.counter.id,
        purchasedCreditPurchaseId: data.purchase.id, sourceKey: randomUUID(), quantity: 3, status: "RESERVED" } });
    });
    gate.release();
    await expect(pending).resolves.toMatchObject({ code: "REQUESTED", availableAmount: 7 });
    expect(observations).toBe(2);
    expect(sinkCalls).toBe(1);
    const state = await data.state();
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0]).toMatchObject({ availableAmountAtRequestSnapshot: 7, reservedAmountAtRequestSnapshot: 3 });
    expect(state.purchase).toMatchObject({ version: 2, reservedAmount: 3, currentAmount: 10, status: "WITHDRAWN" });
    expect(state.counter).toMatchObject({ version: 2, reservedQuantity: 3, refundingQuantity: 7 });
  });

  it("reauthorizes a pending refund against a reactivation committed on another connection", async () => {
    const data = await createRefundFixture(fixture.database, "reactivation-race");
    const gate = barrier();
    const pending = data.service(transactionPort(fixture.database, { before: () => gate.wait() })).requestRefund(data.input);
    await gate.arrived;
    const other = data.service(fixture.createClient("reactivation-writer"));
    await expect(other.requestRefund({ ...data.input, requestId: randomUUID() })).resolves.toMatchObject({ code: "REQUESTED" });
    await expect(other.reactivateRefund(data.input)).resolves.toMatchObject({ code: "REACTIVATED" });
    gate.release();
    await expect(pending).resolves.toMatchObject({ code: "REQUESTED" });
    const state = await data.state();
    expect(state.refunds.map(refund => refund.status).sort()).toEqual(["CANCELLED", "REQUESTED"]);
    expect(state.purchase).toMatchObject({ status: "WITHDRAWN", version: 3, currentAmount: 10, reservedAmount: 0 });
    expect(state.counter).toMatchObject({ version: 3, refundingQuantity: 10, reservedQuantity: 0 });
  });

  it("keeps the provider action fence and exposes the migrated zero-credit constraint", async () => {
    const data = await createRefundFixture(fixture.database, "provider-fence");
    const service = data.service();
    await service.requestRefund(data.input);
    const state = await data.state();
    const writer = fixture.createClient("provider-action-writer");
    await writer.recoveryCreditRefund.update({ where: { id: state.refunds[0].id }, data: { providerReference: "started", version: { increment: 1 } } });
    await expect(service.reactivateRefund(data.input)).resolves.toMatchObject({ code: "REACTIVATION_NOT_AVAILABLE" });
    expect((await data.state()).counter.refundingQuantity).toBe(10);
    // Existing migrations prohibit the WITHDRAWN + zero state required by
    // the service's COMPLETED_NO_CREDITS branch. Keep this evidence visible;
    // an architect amendment is required instead of weakening that constraint.
    await expect(writer.recoveryCreditPurchase.update({ where: { id: data.purchase.id },
      data: { currentAmount: 0, version: { increment: 1 } },
    })).rejects.toThrow("RecoveryCreditPurchase_lifecycle_amounts");
    const preserved = await data.state();
    expect(preserved.purchase).toMatchObject({ status: "WITHDRAWN", currentAmount: 10, reservedAmount: 0, version: 1 });
    expect(preserved.counter).toMatchObject({ refundingQuantity: 10, reservedQuantity: 0, version: 1 });
    expect(data.active).toHaveBeenCalledOnce();
  });

  it("rolls back refund creation and withdrawal when persistence fails before the counter CAS", async () => {
    const data = await createRefundFixture(fixture.database, "refund-rollback");
    const failure = new Error("injected counter persistence failure");
    const port = transactionPort(fixture.database, { beforeMethod: async (model, method) => {
      if (model === "shopEntitlementCounter" && method === "updateMany") throw failure;
    } });
    await expect(data.service(port).requestRefund(data.input)).rejects.toBe(failure);
    const state = await data.state();
    expect(state.refunds).toHaveLength(0);
    expect(state.purchase).toMatchObject({ status: "ACTIVE", currentAmount: 10, reservedAmount: 0, version: 0 });
    expect(state.counter).toMatchObject({ refundingQuantity: 0, reservedQuantity: 0, version: 0 });
  });
});
