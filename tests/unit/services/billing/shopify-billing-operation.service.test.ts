import { describe, expect, it, vi } from "vitest";
import {
  BillingOperationKind,
  BillingOperationState,
  MerchantPricingBillingPeriod,
  MerchantPricingPlanKind,
  MerchantPricingUsagePricingMode,
  ShopPlatform,
  type BillingOperation,
} from "@prisma/client";

import {
  calculateShopifyUsageEventQuoteMinor,
  ShopifyBillingOperationService,
} from "../../../../app/services/billing/shopify-billing-operation.service";

const now = new Date("2026-10-10T12:00:00.000Z");

type OperationCreate = Omit<BillingOperation, "id" | "createdAt" | "updatedAt">;
type EnumFilter<T extends string> = T | { in: readonly T[] };
type OperationWhere = {
  id?: string;
  shopId?: string;
  kind?: EnumFilter<BillingOperationKind>;
  state?: EnumFilter<BillingOperationState>;
  providerReference?: string | null;
};
type PlanRecord = {
  id: string;
  shopifyPlanHandle: string;
  planKind: MerchantPricingPlanKind;
  isActive: boolean;
  recurringAmountMinor: number;
  currency: string;
  billingPeriod: MerchantPricingBillingPeriod;
};

function matchesFilter<T extends string>(filter: EnumFilter<T> | undefined, value: T): boolean {
  if (filter === undefined) return true;
  return typeof filter === "string" ? value === filter : filter.in.includes(value);
}

function operationHarness() {
  let sequence = 0;
  const operations: BillingOperation[] = [];
  const plans = new Map<string, PlanRecord>([
    ["free", {
      id: "pricing-free",
      shopifyPlanHandle: "free",
      planKind: MerchantPricingPlanKind.FREE,
      isActive: true,
      recurringAmountMinor: 0,
      currency: "USD",
      billingPeriod: MerchantPricingBillingPeriod.EVERY_30_DAYS,
    }],
    ["growth", {
      id: "pricing-growth",
      shopifyPlanHandle: "growth",
      planKind: MerchantPricingPlanKind.PAID_METERED,
      isActive: true,
      recurringAmountMinor: 4900,
      currency: "USD",
      billingPeriod: MerchantPricingBillingPeriod.EVERY_30_DAYS,
    }],
    ["scale", {
      id: "pricing-scale",
      shopifyPlanHandle: "scale",
      planKind: MerchantPricingPlanKind.PAID_METERED,
      isActive: true,
      recurringAmountMinor: 9900,
      currency: "USD",
      billingPeriod: MerchantPricingBillingPeriod.EVERY_30_DAYS,
    }],
  ]);
  let platform: ShopPlatform = ShopPlatform.SHOPIFY;

  const billingOperation = {
    upsert: vi.fn(async ({ where, create }: {
      where: { shopId_requestKey: { shopId: string; requestKey: string } };
      create: OperationCreate;
    }) => {
      const key = where.shopId_requestKey;
      const existing = operations.find((candidate) =>
        candidate.shopId === key.shopId && candidate.requestKey === key.requestKey,
      );
      if (existing) return existing;
      const created: BillingOperation = {
        id: `operation-${++sequence}`,
        ...create,
        createdAt: now,
        updatedAt: now,
      };
      operations.push(created);
      return created;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      operations.find((candidate) => candidate.id === where.id) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: OperationWhere }) => operations
      .filter((candidate) => {
        if (where.shopId !== undefined && candidate.shopId !== where.shopId) return false;
        if (!matchesFilter(where.kind, candidate.kind)) return false;
        if (!matchesFilter(where.state, candidate.state)) return false;
        if (where.providerReference !== undefined && candidate.providerReference !== where.providerReference) return false;
        return true;
      })
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    ),
    updateMany: vi.fn(async ({ where, data }: {
      where: OperationWhere;
      data: Partial<BillingOperation>;
    }) => {
      let count = 0;
      for (const candidate of operations) {
        if (where.id !== undefined && candidate.id !== where.id) continue;
        if (!matchesFilter(where.state, candidate.state)) continue;
        if (where.providerReference !== undefined && candidate.providerReference !== where.providerReference) continue;
        Object.assign(candidate, data, { updatedAt: now });
        count += 1;
      }
      return { count };
    }),
  };
  const transaction = {
    shop: {
      findUnique: vi.fn(async () => ({ platform })),
    },
    merchantPricingPlan: {
      findUnique: vi.fn(async ({ where }: { where: { shopifyPlanHandle: string } }) =>
        plans.get(where.shopifyPlanHandle) ?? null),
    },
    billingOperation,
  };
  return {
    service: new ShopifyBillingOperationService({} as never),
    transaction,
    operations,
    plans,
    setPlatform(value: ShopPlatform) {
      platform = value;
    },
  };
}

describe("ShopifyBillingOperationService", () => {
  it("creates one deterministic Shop-owned initial subscription operation and reuses it", async () => {
    const harness = operationHarness();
    const input = {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: null,
    };

    const first = await harness.service.recordInitialPaidIntent(harness.transaction as never, input);
    const replay = await harness.service.recordInitialPaidIntent(harness.transaction as never, input);

    expect(replay.id).toBe(first.id);
    expect(harness.operations).toHaveLength(1);
    expect(first).toMatchObject({
      shopId: "shop-1",
      kind: BillingOperationKind.SUBSCRIPTION_CREATE,
      state: BillingOperationState.INITIATING,
      merchantPricingPlanId: "pricing-growth",
      quotedAmountMinor: 4900,
      quotedCurrency: "USD",
      quotedBillingPeriod: MerchantPricingBillingPeriod.EVERY_30_DAYS,
      providerReference: null,
    });
    expect(Buffer.from(first.requestFingerprint)).toHaveLength(32);
    expect(first).not.toHaveProperty("subscriptionId");
    expect(first).not.toHaveProperty("provider");
  });

  it("rejects an idempotency-key replay whose quoted intent changed", async () => {
    const harness = operationHarness();
    const input = {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: "lifecycle-1",
    };
    await harness.service.recordInitialPaidIntent(harness.transaction as never, input);
    harness.plans.get("growth")!.recurringAmountMinor = 5900;

    await expect(harness.service.recordInitialPaidIntent(harness.transaction as never, input))
      .rejects.toThrow("idempotency conflict");
    expect(harness.operations).toHaveLength(1);
  });

  it("fails closed for a Woo-owned Shop", async () => {
    const harness = operationHarness();
    harness.setPlatform(ShopPlatform.WOOCOMMERCE);

    await expect(harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: null,
    })).rejects.toThrow("Shopify Shop");
    expect(harness.operations).toHaveLength(0);
  });

  it("confirms one unambiguous initial paid intent and attaches the trusted provider reference", async () => {
    const harness = operationHarness();
    const operation = await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: null,
    });

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/1",
      cancelAtEndOfCycle: false,
    });

    expect(harness.operations.find((candidate) => candidate.id === operation.id)).toMatchObject({
      state: BillingOperationState.CONFIRMED,
      providerReference: "gid://shopify/AppSubscription/1",
    });
  });

  it("does not confirm ambiguous provider outcomes when multiple unresolved creates match", async () => {
    const harness = operationHarness();
    await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: "lifecycle-1",
    });
    await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-2",
      targetPlanHandle: "growth",
      lifecycleEventId: "lifecycle-2",
    });

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/1",
      cancelAtEndOfCycle: false,
    });

    expect(harness.operations).toHaveLength(2);
    expect(harness.operations.every((operation) =>
      operation.state === BillingOperationState.INITIATING && operation.providerReference === null,
    )).toBe(true);
  });

  it("records a hosted paid switch as awaiting confirmation and confirms it from exact provider state", async () => {
    const harness = operationHarness();
    const operation = await harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "scale",
      previousPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/1",
      result: "pending",
      cancelAtEndOfCycle: false,
      providerCurrentPeriodStart: "2026-10-01T00:00:00.000Z",
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: "2026-10-31T00:00:00.000Z",
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    });

    expect(operation).toMatchObject({
      kind: BillingOperationKind.PLAN_SWITCH,
      state: BillingOperationState.AWAITING_CONFIRMATION,
      merchantPricingPlanId: "pricing-scale",
      providerReference: "gid://shopify/AppSubscription/1",
    });

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "scale",
      providerReference: "gid://shopify/AppSubscription/1",
      cancelAtEndOfCycle: false,
    });
    expect(harness.operations[0].state).toBe(BillingOperationState.CONFIRMED);
  });

  it("confirms an unambiguous switch without rewriting its write-once provider reference", async () => {
    const harness = operationHarness();
    const operation = await harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "scale",
      previousPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/original",
      result: "pending",
      cancelAtEndOfCycle: false,
      providerCurrentPeriodStart: "2026-10-01T00:00:00.000Z",
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: "2026-10-31T00:00:00.000Z",
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    });

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "scale",
      providerReference: "gid://shopify/AppSubscription/replaced",
      cancelAtEndOfCycle: false,
    });

    expect(harness.operations.find((candidate) => candidate.id === operation?.id)).toMatchObject({
      state: BillingOperationState.CONFIRMED,
      providerReference: "gid://shopify/AppSubscription/original",
    });
  });

  it("does not fabricate a paid switch reference when Shopify exposes no stable billing reference", async () => {
    const harness = operationHarness();

    await expect(harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "scale",
      previousPlanHandle: "growth",
      providerReference: null,
      result: "pending",
      cancelAtEndOfCycle: false,
      providerCurrentPeriodStart: "2026-10-01T00:00:00.000Z",
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: "2026-10-31T00:00:00.000Z",
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    })).resolves.toBeNull();

    expect(harness.operations).toHaveLength(0);
  });

  it("records cancellation from trusted scheduled-cancel evidence without changing the hosted result classification", async () => {
    const harness = operationHarness();
    const operation = await harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "free",
      previousPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/1",
      result: "mismatch",
      cancelAtEndOfCycle: true,
      providerCurrentPeriodStart: "2026-10-01T00:00:00.000Z",
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: null,
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    });

    expect(operation).toMatchObject({
      kind: BillingOperationKind.CANCEL,
      state: BillingOperationState.CONFIRMED,
      providerReference: "gid://shopify/AppSubscription/1",
      merchantPricingPlanId: null,
    });
  });

  it("does not confirm more than one cancellation from the same provider outcome", async () => {
    const harness = operationHarness();
    for (const boundary of ["2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]) {
      await harness.service.recordHostedPlanChange(harness.transaction as never, {
        shopId: "shop-1",
        requestedPlanHandle: "free",
        previousPlanHandle: "growth",
        providerReference: "gid://shopify/AppSubscription/1",
        result: "no_active",
        cancelAtEndOfCycle: false,
        providerCurrentPeriodStart: null,
        providerCurrentPeriodEnd: null,
        providerPendingEffectiveAt: null,
        previousCurrentPeriodEnd: new Date(boundary),
        subscriptionId: "subscription-1",
      });
    }
    for (const operation of harness.operations) operation.state = BillingOperationState.INITIATING;

    await harness.service.reconcileNoActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
    });

    expect(harness.operations.every((operation) => operation.state === BillingOperationState.INITIATING)).toBe(true);
  });

  it("links a positive Shopify one-time charge to the exact purchase and catalogue usage event", async () => {
    const harness = operationHarness();
    const operation = await harness.service.recordOneTimeChargeIntent(harness.transaction as never, {
      shopId: "shop-1",
      purchaseId: "purchase-1",
      providerQuantityBefore: 2,
      providerReference: "moda:shopify-usage:purchase-1",
      usageEvent: {
        id: "usage-bronze",
        pricingMode: MerchantPricingUsagePricingMode.FIXED,
        currency: "USD",
        fixedUnitAmountMinor: 2500,
        tiers: [],
      },
    });

    expect(operation).toMatchObject({
      kind: BillingOperationKind.ONE_TIME_CHARGE,
      state: BillingOperationState.AWAITING_CONFIRMATION,
      merchantPricingUsageEventId: "usage-bronze",
      recoveryCreditPurchaseId: "purchase-1",
      quotedAmountMinor: 2500,
      quotedCurrency: "USD",
      providerReference: "moda:shopify-usage:purchase-1",
    });
  });

  it("does not invent a one-time charge for a zero-cost provider meter", async () => {
    const harness = operationHarness();
    await expect(harness.service.recordOneTimeChargeIntent(harness.transaction as never, {
      shopId: "shop-1",
      purchaseId: "purchase-1",
      providerQuantityBefore: 0,
      providerReference: "moda:shopify-usage:purchase-1",
      usageEvent: {
        id: "usage-free",
        pricingMode: MerchantPricingUsagePricingMode.FIXED,
        currency: "USD",
        fixedUnitAmountMinor: 0,
        tiers: [],
      },
    })).rejects.toThrow("quote is unavailable");
    expect(harness.operations).toHaveLength(0);
  });

  it("calculates a positive volume-tier delta from the provider before quantity", () => {
    expect(calculateShopifyUsageEventQuoteMinor({
      id: "usage-volume",
      pricingMode: MerchantPricingUsagePricingMode.VOLUME,
      currency: "USD",
      fixedUnitAmountMinor: null,
      tiers: [
        { position: 0, upTo: 2, amountPerUnitMinor: 1000, flatAmountMinor: 0 },
        { position: 1, upTo: null, amountPerUnitMinor: 800, flatAmountMinor: 0 },
      ],
    }, 2)).toBe(400);
  });
});
