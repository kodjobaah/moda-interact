/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";

import { RecoveryCreditPurchaseManagementService } from "../../../app/services/billing/recovery-credit-purchase-management.service";

const date = new Date("2026-09-14T00:00:00.000Z");

function purchase(id: string, shopId = "shop-1", status = "ACTIVE", currentAmount = 3, reservedAmount = 1) {
  return {
    id, shopId, status, createdAt: date, activatedAt: date, creditsGranted: 5, currentAmount, reservedAmount, version: 2,
    shopifyPlanHandleSnapshot: "growth", plan: { name: "Growth", shopifyPlanHandle: "growth" },
    providerPurchaseAmount: "12.50", providerPurchaseCurrency: "USD", billingPeriodId: "period-1",
    providerSubscriptionIdSnapshot: "sub-1", shopifyEventHandleSnapshot: "pack-meter",
    refunds: [],
  } as any;
}

function database(purchases: any[]) {
  const rows = new Map(purchases.map((row) => [row.id, row]));
  const aggregate = { id: "counter-1", version: 4, refundingQuantity: 2, reservedQuantity: 1 };
  const transaction: any = {
    recoveryCreditPurchase: {
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row || row.version !== where.version || row.status !== where.status || row.currentAmount !== where.currentAmount || row.reservedAmount !== where.reservedAmount) return { count: 0 };
        Object.assign(row, { ...data, status: data.status ?? row.status, version: row.version + 1 });
        return { count: 1 };
      }),
    },
    recoveryCreditRefund: {
      create: vi.fn(async ({ data }: any) => { const row = rows.get(data.purchaseId); row.refunds.push({ ...data, id: "refund-1", version: 0 }); return data; }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    shopEntitlementCounter: {
      findUnique: vi.fn(async () => aggregate),
      updateMany: vi.fn(async ({ where, data }: any) => { if (where.version !== aggregate.version) return { count: 0 }; aggregate.refundingQuantity += data.refundingQuantity.increment ?? -data.refundingQuantity.decrement; aggregate.version += 1; return { count: 1 }; }),
    },
  };
  return { database: { recoveryCreditPurchase: { count: vi.fn(async () => rows.size), findMany: vi.fn(async () => [...rows.values()]) }, $transaction: vi.fn(async (callback: any) => callback(transaction)) } as any, rows, aggregate, transaction };
}

describe("RecoveryCreditPurchaseManagementService", () => {
  it("lists only the authenticated shop with bounded pagination and computed availability", async () => {
    const fixture = database([purchase("one"), purchase("two", "other")]);
    const result = await new RecoveryCreditPurchaseManagementService(fixture.database).listPurchaseHistory({ shopId: "shop-1", pageSize: 100 });
    expect(result.pageSize).toBe(50);
    expect(result.purchases).toHaveLength(2);
    expect(result.purchases[0].availableAmount).toBe(2);
    expect(fixture.database.recoveryCreditPurchase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shopId: "shop-1" }, take: 50 }));
  });

  it("maps every canonical purchase status without exposing provider internals", async () => {
    const fixture = database([
      purchase("requested", "shop-1", "REQUESTED", 0, 0),
      purchase("active", "shop-1", "ACTIVE", 3, 1),
      purchase("completed", "shop-1", "COMPLETED", 0, 0),
      purchase("withdrawn", "shop-1", "WITHDRAWN", 2, 1),
      purchase("refunded", "shop-1", "REFUNDED", 0, 0),
    ]);
    const result = await new RecoveryCreditPurchaseManagementService(fixture.database).listPurchaseHistory({ shopId: "shop-1" });
    expect(result.purchases.map(({ status }) => status)).toEqual(["REQUESTED", "ACTIVE", "COMPLETED", "WITHDRAWN", "REFUNDED"]);
    expect(JSON.stringify(result)).not.toContain("providerSubscriptionIdSnapshot");
  });

  it("withdraws fresh available capacity and holds it in the aggregate", async () => {
    const fixture = database([purchase("one")]);
    const result = await new RecoveryCreditPurchaseManagementService(fixture.database).requestRefund({ shopId: "shop-1", purchaseId: "one", requestId: "request-1", quantity: 999, amount: "0.01", currency: "EUR" });
    expect(result).toMatchObject({ code: "REQUESTED", availableAmount: 2 });
    expect(fixture.rows.get("one").status).toBe("WITHDRAWN");
    expect(fixture.aggregate.refundingQuantity).toBe(4);
    expect(fixture.transaction.recoveryCreditRefund.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ availableAmountAtRequestSnapshot: 2, source: "MERCHANT_UI" }) }));
  });

  it("denies cross-shop mutation without revealing whether the purchase exists", async () => {
    const fixture = database([purchase("one", "shop-2")]);
    const result = await new RecoveryCreditPurchaseManagementService(fixture.database).requestRefund({ shopId: "shop-1", purchaseId: "one", requestId: "request-1" });
    expect(result).toEqual({ purchaseId: "one", code: "NOT_FOUND" });
    expect(fixture.transaction.recoveryCreditRefund.create).not.toHaveBeenCalled();
  });

  it("returns no mutation when fresh availability is zero", async () => {
    const fixture = database([purchase("one", "shop-1", "ACTIVE", 1, 1)]);
    const result = await new RecoveryCreditPurchaseManagementService(fixture.database).requestRefund({ shopId: "shop-1", purchaseId: "one", requestId: "request-1" });
    expect(result.code).toBe("REFUND_NOT_AVAILABLE");
    expect(fixture.transaction.recoveryCreditRefund.create).not.toHaveBeenCalled();
    expect(fixture.rows.get("one").status).toBe("ACTIVE");
  });

  it("processes a batch independently and safely replays a live request", async () => {
    const fixture = database([purchase("one"), purchase("two", "shop-1", "COMPLETED", 0, 0)]);
    const service = new RecoveryCreditPurchaseManagementService(fixture.database);
    await expect(service.requestRefundBatch({ shopId: "shop-1", purchaseIds: ["one", "two", "one"], requestId: "batch-1" })).resolves.toEqual([
      expect.objectContaining({ purchaseId: "one", code: "REQUESTED" }),
      expect.objectContaining({ purchaseId: "two", code: "COMPLETED" }),
    ]);
    expect(fixture.rows.get("one").refunds).toHaveLength(1);
  });

  it("replays a live refund without creating another row", async () => {
    const fixture = database([purchase("one")]);
    const service = new RecoveryCreditPurchaseManagementService(fixture.database);
    await service.requestRefund({ shopId: "shop-1", purchaseId: "one", requestId: "request-1" });
    await expect(service.requestRefund({ shopId: "shop-1", purchaseId: "one", requestId: "request-1" })).resolves.toMatchObject({ code: "REQUESTED" });
    expect(fixture.transaction.recoveryCreditRefund.create).toHaveBeenCalledTimes(1);
  });

  it("retries the whole refund transaction after a serialization conflict", async () => {
    const fixture = database([purchase("one")]);
    const originalTransaction = fixture.database.$transaction;
    fixture.database.$transaction = vi.fn()
      .mockRejectedValueOnce(new (await import("@prisma/client")).Prisma.PrismaClientKnownRequestError("serialization failure", { code: "P2034", clientVersion: "6" }))
      .mockImplementation(originalTransaction);
    await expect(new RecoveryCreditPurchaseManagementService(fixture.database).requestRefund({ shopId: "shop-1", purchaseId: "one", requestId: "request-1" })).resolves.toMatchObject({ code: "REQUESTED" });
    expect(fixture.database.$transaction).toHaveBeenCalledTimes(2);
  });

  it("reactivates a pre-provider refund and releases only its held available amount", async () => {
    const fixture = database([purchase("one", "shop-1", "WITHDRAWN", 3, 1)]);
    fixture.rows.get("one").refunds.push({ id: "refund-1", status: "REQUESTED", version: 0, providerReference: null, providerActionKind: null, providerConfirmedAt: null });
    const result = await new RecoveryCreditPurchaseManagementService(fixture.database).reactivateRefund({ shopId: "shop-1", purchaseId: "one" });
    expect(result).toMatchObject({ code: "REACTIVATED", currentAmount: 3, reservedAmount: 1 });
    expect(fixture.rows.get("one").status).toBe("ACTIVE");
    expect(fixture.aggregate.refundingQuantity).toBe(0);
  });

  it("rejects provider-action refunds and completes a withdrawn empty purchase", async () => {
    const locked = database([purchase("locked", "shop-1", "WITHDRAWN", 2, 0)]);
    locked.rows.get("locked").refunds.push({ id: "refund-1", status: "PROVIDER_ACTION_REQUIRED", version: 0, providerReference: "ref", providerActionKind: "REFUND", providerConfirmedAt: null });
    await expect(new RecoveryCreditPurchaseManagementService(locked.database).reactivateRefund({ shopId: "shop-1", purchaseId: "locked" })).resolves.toEqual({ purchaseId: "locked", code: "REACTIVATION_NOT_AVAILABLE" });

    const empty = database([purchase("empty", "shop-1", "WITHDRAWN", 0, 0)]);
    empty.rows.get("empty").refunds.push({ id: "refund-1", status: "REQUESTED", version: 0, providerReference: null, providerActionKind: null, providerConfirmedAt: null });
    await expect(new RecoveryCreditPurchaseManagementService(empty.database).reactivateRefund({ shopId: "shop-1", purchaseId: "empty" })).resolves.toEqual({ purchaseId: "empty", code: "COMPLETED_NO_CREDITS" });
  });
});