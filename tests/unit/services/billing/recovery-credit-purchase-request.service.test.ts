import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { createShopifyUsageIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

import { BillingPlanResolutionService } from "../../../../app/services/billing/billing-plan-resolution.service";
import { RecoveryCreditPurchaseRequestService } from "../../../../app/services/billing/recovery-credit-purchase-request.service";
import type { BillingProvider, ProviderSubscription } from "../../../../app/services/billing/billing.types";

const shopId = "shop-1";
const purchaseId = "11111111-1111-4111-8111-111111111111";
const eventHandle = "credit-pack-meter";
const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-31T00:00:00.000Z");

function providerSubscription(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    provider: "SHOPIFY",
    planHandle: "growth",
    billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: { handle: "growth", description: null, price: { amount: "10.00", currency: "USD" } },
    pendingFlatRatePlan: null,
    usageItems: [{
      handle: eventHandle,
      description: "Recovery credits",
      price: { kind: "TIERED", active: true, currency: "USD", tiersMode: "VOLUME", tiers: [] },
      usage: { quantity: 0.5, costAmount: "1.25", costCurrency: "USD" },
    }],
    usageEventHandles: [eventHandle, "message-meter"],
    pendingPlanHandle: null,
    pendingEffectiveAt: null,
    status: "ACTIVE",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-subscription-1",
    providerUsageSnapshot: [],
    ...overrides,
  };
}

function createHarness(options: {
  snapshots?: Array<{ activeSubscription: ProviderSubscription | null; latestLifecycleEvent: null | { id: string; eventType: "SUBSCRIPTION_FROZEN"; state: "FROZEN"; occurredAt: Date; cancelEffectiveOn: null; planHandle: string; billingPeriod: string } }>;
  catalogueRead?: (call: number) => { shopifyPlanHandle: string; usageEvents: Array<{ cataloguePosition: number; eventHandle: string; adminLabel: string; creditsGrantedPerUnit: number }> } | null;
  existingPurchase?: Record<string, unknown> | null;
  unresolved?: Record<string, unknown> | null;
  transactionSubscription?: Record<string, unknown>;
  transactionError?: unknown;
  replayAfterUniqueError?: Record<string, unknown> | null;
} = {}) {
  const plan = {
    id: "plan-1",
    shopifyPlanHandle: "growth",
    active: true,
    kind: "PAID_METERED",
    shopifyUsageEventHandle: "message-meter",
  };
  const billingPeriod = { id: "period-1", periodStart, periodEnd, status: "OPEN" };
  const subscription = {
    id: "subscription-1",
    shopId,
    status: "ACTIVE",
    planId: "plan-1",
    plan,
    billingPeriodId: "period-1",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    billingPeriod,
  };
  const purchases = new Map<string, Record<string, unknown>>();
  const usageEvents: Array<Record<string, unknown>> = [];
  let catalogueReads = 0;
  let topLevelPurchaseReads = 0;
  const transactionEvents: string[] = [];
  const transactionOptions: unknown[] = [];
  const purchaseFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    topLevelPurchaseReads += 1;
    if (options.existingPurchase && topLevelPurchaseReads === 1) return options.existingPurchase;
    if (options.replayAfterUniqueError && topLevelPurchaseReads > 1) return options.replayAfterUniqueError;
    return purchases.get(where.id) ?? null;
  });
  const requestSubscription = { findUnique: vi.fn().mockResolvedValue(subscription) };
  const transactionSubscription = { findUnique: vi.fn(async () => ({ ...subscription, ...options.transactionSubscription })) };
  const transaction = {
    $queryRaw: vi.fn(async (query: { strings?: string[] }) => { transactionEvents.push("subscription-lock"); return query; }),
    recoveryCreditPurchase: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => purchases.get(where.id) ?? null),
      findFirst: vi.fn(async () => { transactionEvents.push("unresolved-lookup"); return options.unresolved ?? null; }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const record = { ...data, usageEvent: usageEvents.find((event) => event.id === data.usageEventId) };
        purchases.set(String(data.id), record);
        return record;
      }),
    },
    subscription: transactionSubscription,
    usageEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        transactionEvents.push("usage-event-write");
        const record = { ...data };
        usageEvents.push(record);
        return record;
      }),
    },
  };
  const database = {
    recoveryCreditPurchase: { findUnique: purchaseFindUnique },
    shop: { findUnique: vi.fn().mockResolvedValue({ id: shopId, status: "ACTIVE", shopifyShopId: "shopify-shop-1" }) },
    subscription: requestSubscription,
    merchantPricingPlan: {
      findUnique: vi.fn(async () => {
        catalogueReads += 1;
        return options.catalogueRead?.(catalogueReads) ?? {
          shopifyPlanHandle: "growth",
          usageEvents: [{ position: 0, eventHandle, adminLabel: "Credits", creditsGrantedPerUnit: 100 }],
        };
      }),
    },
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>, isolation?: unknown) => {
      transactionEvents.push("transaction");
      transactionOptions.push(isolation);
      if (options.transactionError) throw options.transactionError;
      return callback(transaction);
    }),
  };
  const snapshots = options.snapshots ?? [
    { activeSubscription: providerSubscription(), latestLifecycleEvent: null },
    { activeSubscription: providerSubscription(), latestLifecycleEvent: null },
  ];
  const provider = {
    getActiveSubscription: vi.fn(),
    getSubscriptionLifecycleSnapshot: vi.fn(async () => {
      transactionEvents.push("provider");
      return snapshots.shift() ?? { activeSubscription: providerSubscription(), latestLifecycleEvent: null };
    }),
  };
  const planResolution = new BillingPlanResolutionService(database as never);
  const service = new RecoveryCreditPurchaseRequestService(provider as unknown as BillingProvider, database as never, planResolution);
  return {
    service,
    provider,
    database,
    transaction,
    transactionEvents,
    transactionOptions,
    usageEvents,
    purchases,
    get catalogueReads() { return catalogueReads; },
    get topLevelPurchaseReads() { return topLevelPurchaseReads; },
  };
}

describe("RecoveryCreditPurchaseRequestService", () => {
  it("performs exactly two provider snapshots and two catalogue reads before its Serializable transaction", async () => {
    const harness = createHarness();
    const result = await harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", purchaseId, eventHandle);

    expect(result).toMatchObject({ id: purchaseId, creditsGranted: 100, status: "REQUESTED" });
    expect(harness.provider.getSubscriptionLifecycleSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.catalogueReads).toBe(2);
    expect(harness.transactionEvents.filter((event) => event === "provider")).toHaveLength(2);
    expect(harness.transactionEvents.filter((event) => event === "transaction")).toHaveLength(1);
    expect(harness.transactionEvents.indexOf("transaction")).toBeGreaterThan(harness.transactionEvents.lastIndexOf("provider"));
    expect(harness.transactionOptions).toEqual([{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }]);
    expect(harness.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(harness.transaction.recoveryCreditPurchase.findFirst).toHaveBeenCalledTimes(1);
    expect(harness.usageEvents[0]).toMatchObject({
      provider: "SHOPIFY",
      billingPeriodId: "period-1",
      shopifyReportState: "PENDING",
      shopifyEventHandle: eventHandle,
      shopifyIdempotencyKey: expect.any(String),
    });
    expect(harness.usageEvents[0].shopifyIdempotencyKey).toBe(
      createShopifyUsageIdempotencyKey(shopId, String(harness.usageEvents[0].id)),
    );
    expect(harness.purchases.get(purchaseId)).toMatchObject({
      provider: "SHOPIFY",
      billingPeriodId: "period-1",
      shopifyPlanHandleSnapshot: "growth",
      shopifyEventHandleSnapshot: eventHandle,
      providerSubscriptionIdSnapshot: expect.any(String),
      providerUsageQuantityBeforeSnapshot: 0.5,
      providerUsageCostBeforeSnapshot: "1.25",
      providerUsageCostCurrencyBeforeSnapshot: "USD",
      usageEventId: expect.any(String),
    });
    expect(harness.transaction.recoveryCreditPurchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shopId,
          provider: "SHOPIFY",
          status: "REQUESTED",
          shopifyEventHandleSnapshot: eventHandle,
        }),
      }),
    );
  });

  it("rejects provider evidence changes before entering the write transaction", async () => {
    const changed = providerSubscription();
    changed.usageItems[0].usage!.quantity = 1;
    const harness = createHarness({ snapshots: [
      { activeSubscription: providerSubscription(), latestLifecycleEvent: null },
      { activeSubscription: changed, latestLifecycleEvent: null },
    ] });

    await expect(harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", purchaseId, eventHandle))
      .rejects.toThrow("provider configuration changed");
    expect(harness.provider.getSubscriptionLifecycleSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.catalogueReads).toBe(1);
    expect(harness.database.$transaction).not.toHaveBeenCalled();
    expect(harness.usageEvents).toHaveLength(0);
  });

  it("rejects a provider billing cycle that does not exactly match the durable local period", async () => {
    const mismatched = providerSubscription({ currentPeriodStart: new Date("2026-09-02T00:00:00.000Z") });
    const harness = createHarness({ snapshots: [
      { activeSubscription: mismatched, latestLifecycleEvent: null },
      { activeSubscription: mismatched, latestLifecycleEvent: null },
    ] });

    await expect(harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", purchaseId, eventHandle))
      .rejects.toThrow("current Shopify billing cycle");
    expect(harness.provider.getSubscriptionLifecycleSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.database.$transaction).not.toHaveBeenCalled();
    expect(harness.usageEvents).toHaveLength(0);
  });

  it("rejects a frozen lifecycle before catalogue or transaction access", async () => {
    const harness = createHarness({ snapshots: [{
      activeSubscription: providerSubscription(),
      latestLifecycleEvent: {
        id: "frozen-event",
        eventType: "SUBSCRIPTION_FROZEN",
        state: "FROZEN",
        occurredAt: new Date("2026-09-15T00:00:00.000Z"),
        cancelEffectiveOn: null,
        planHandle: "growth",
        billingPeriod: "EVERY_30_DAYS",
      },
    }] });

    await expect(harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", purchaseId, eventHandle))
      .rejects.toThrow("Shopify subscription is frozen");
    expect(harness.provider.getSubscriptionLifecycleSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.catalogueReads).toBe(0);
    expect(harness.database.$transaction).not.toHaveBeenCalled();
    expect(harness.usageEvents).toHaveLength(0);
  });

  it("fails closed when the second catalogue read changes the granted credits", async () => {
    const harness = createHarness({ catalogueRead: (call) => ({
      shopifyPlanHandle: "growth",
      usageEvents: [{ cataloguePosition: 0, eventHandle, adminLabel: "Credits", creditsGrantedPerUnit: call === 1 ? 100 : 200 }],
    }) });

    await expect(harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", purchaseId, eventHandle))
      .rejects.toThrow("configuration changed");
    expect(harness.catalogueReads).toBe(2);
    expect(harness.provider.getSubscriptionLifecycleSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.database.$transaction).not.toHaveBeenCalled();
    expect(harness.usageEvents).toHaveLength(0);
  });

  it("replays an existing purchase without provider or catalogue access", async () => {
    const existingPurchase = { id: purchaseId, shopId, provider: "SHOPIFY", status: "REQUESTED" };
    const harness = createHarness({ existingPurchase });

    await expect(harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", purchaseId, eventHandle))
      .resolves.toBe(existingPurchase);
    expect(harness.provider.getSubscriptionLifecycleSnapshot).not.toHaveBeenCalled();
    expect(harness.catalogueReads).toBe(0);
    expect(harness.database.$transaction).not.toHaveBeenCalled();
  });

  it("does not replay a cross-provider purchase with the same ID", async () => {
    const harness = createHarness({
      existingPurchase: {
        id: purchaseId,
        shopId,
        provider: "WOOCOMMERCE",
        status: "REQUESTED",
      },
    });

    await expect(
      harness.service.requestRecoveryCreditPack(
        shopId,
        "BUY_RECOVERY_CREDIT_PACK",
        purchaseId,
        eventHandle,
      ),
    ).rejects.toThrow("another shop or billing provider");
    expect(harness.provider.getSubscriptionLifecycleSnapshot).not.toHaveBeenCalled();
    expect(harness.database.$transaction).not.toHaveBeenCalled();
  });

  it("blocks an unresolved same-offer request after locking Subscription", async () => {
    const harness = createHarness({ unresolved: { id: "prior-request", status: "REQUESTED" } });

    await expect(harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", purchaseId, eventHandle))
      .rejects.toThrow("already awaiting Shopify confirmation");
    expect(harness.transactionEvents.indexOf("subscription-lock")).toBeLessThan(harness.transactionEvents.indexOf("unresolved-lookup"));
    expect(harness.transaction.usageEvent.create).not.toHaveBeenCalled();
  });

  it("rejects invalid purchase IDs before provider verification", async () => {
    const harness = createHarness();

    await expect(harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", "invalid", eventHandle))
      .rejects.toThrow("valid recovery credit purchase ID");
    expect(harness.provider.getSubscriptionLifecycleSnapshot).not.toHaveBeenCalled();
    expect(harness.database.$transaction).not.toHaveBeenCalled();
  });

  it("recovers a same-ID P2002 race by returning the winning purchase", async () => {
    const winner = { id: purchaseId, shopId, provider: "SHOPIFY", status: "REQUESTED" };
    const harness = createHarness({ transactionError: { code: "P2002" }, replayAfterUniqueError: winner });

    await expect(harness.service.requestRecoveryCreditPack(shopId, "BUY_RECOVERY_CREDIT_PACK", purchaseId, eventHandle))
      .resolves.toBe(winner);
    expect(harness.provider.getSubscriptionLifecycleSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.database.recoveryCreditPurchase.findUnique).toHaveBeenCalledTimes(2);
  });

  it("keeps extra runtime pricing payloads out of the persisted request", async () => {
    const harness = createHarness();

    await (harness.service.requestRecoveryCreditPack as unknown as (...args: unknown[]) => Promise<unknown>)(
      shopId,
      "BUY_RECOVERY_CREDIT_PACK",
      purchaseId,
      eventHandle,
      { creditsGranted: 1, planId: "attacker-plan", meter: "attacker-meter", price: "0" },
    );

    expect(harness.usageEvents[0]).toMatchObject({ shopId, shopifyEventHandle: eventHandle, quantity: 1 });
    expect(harness.purchases.get(purchaseId)).toMatchObject({ creditsGranted: 100, planId: "plan-1" });
  });
});