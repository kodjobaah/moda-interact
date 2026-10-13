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
  shopifyRecurringRequestFingerprint,
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
  it("reuses initial subscription command identity when lifecycle evidence changes", async () => {
    const harness = operationHarness();
    const first = await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: "lifecycle-first",
    });
    const replay = await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: null,
    });

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

  it("leaves a switch unresolved when the observed provider reference differs", async () => {
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
      state: BillingOperationState.AWAITING_CONFIRMATION,
      providerReference: "gid://shopify/AppSubscription/original",
    });
  });

  it("does not fabricate a paid switch reference when Shopify exposes no stable billing reference", async () => {
    const harness = operationHarness();

    const input = {
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
    } as const;

    const operation = await harness.service.recordHostedPlanChange(harness.transaction as never, input);

    expect(operation).toMatchObject({
      kind: BillingOperationKind.PLAN_SWITCH,
      state: BillingOperationState.AWAITING_CONFIRMATION,
      providerReference: null,
    });
    expect(harness.operations).toHaveLength(1);
    expect(await harness.service.recordHostedPlanChange(harness.transaction as never, {
      ...input,
      providerReference: "gid://shopify/AppSubscription/late",
    })).toMatchObject({
      id: operation?.id,
      state: BillingOperationState.AWAITING_CONFIRMATION,
      providerReference: "gid://shopify/AppSubscription/late",
    });
    expect(harness.operations).toHaveLength(1);
  });

  it("keeps recurring fingerprints independent of provider-reference availability", () => {
    const input = {
      kind: BillingOperationKind.PLAN_SWITCH,
      shopId: "shop-1",
      merchantPricingPlanId: "pricing-scale",
      quotedAmountMinor: 9900,
      quotedCurrency: "USD",
      quotedBillingPeriod: MerchantPricingBillingPeriod.EVERY_30_DAYS,
    } as const;
    const withProviderReference = {
      ...input,
      providerReference: "gid://shopify/AppSubscription/late",
    };

    expect(shopifyRecurringRequestFingerprint(input)).toEqual(
      shopifyRecurringRequestFingerprint(withProviderReference),
    );
  });

  it("confirms a uniquely matched paid switch without provider evidence and attaches a later reference", async () => {
    const harness = operationHarness();
    const operation = await harness.service.recordHostedPlanChange(harness.transaction as never, {
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
    });

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "scale",
      providerReference: null,
      cancelAtEndOfCycle: false,
    });

    expect(harness.operations[0]).toMatchObject({
      id: operation?.id,
      state: BillingOperationState.CONFIRMED,
      providerReference: null,
    });
    expect(await harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "scale",
      previousPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/late",
      result: "pending",
      cancelAtEndOfCycle: false,
      providerCurrentPeriodStart: "2026-10-01T00:00:00.000Z",
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: "2026-10-31T00:00:00.000Z",
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    })).toMatchObject({
      id: operation?.id,
      state: BillingOperationState.CONFIRMED,
      providerReference: "gid://shopify/AppSubscription/late",
    });
    await expect(harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "scale",
      previousPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/conflict",
      result: "pending",
      cancelAtEndOfCycle: false,
      providerCurrentPeriodStart: "2026-10-01T00:00:00.000Z",
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: "2026-10-31T00:00:00.000Z",
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    })).rejects.toThrow("provider reference conflict");
  });

  it.each([
    [BillingOperationKind.SUBSCRIPTION_CREATE, "growth"],
    [BillingOperationKind.PLAN_SWITCH, "scale"],
    [BillingOperationKind.CANCEL, "free"],
  ])("enriches a confirmed %s through normal subscription reconciliation", async (kind, planHandle) => {
    const harness = operationHarness();
    let operation: BillingOperation;
    if (kind === BillingOperationKind.SUBSCRIPTION_CREATE) {
      operation = await harness.service.recordInitialPaidIntent(harness.transaction as never, {
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        targetPlanHandle: planHandle,
        lifecycleEventId: null,
      });
      await harness.service.reconcileActiveSubscription(harness.transaction as never, {
        shopId: "shop-1",
        providerPlanHandle: planHandle,
        providerReference: null,
        cancelAtEndOfCycle: false,
      });
    } else {
      const recorded = await harness.service.recordHostedPlanChange(harness.transaction as never, {
        shopId: "shop-1",
        requestedPlanHandle: planHandle,
        previousPlanHandle: "growth",
        providerReference: null,
        result: kind === BillingOperationKind.PLAN_SWITCH ? "current" : "mismatch",
        cancelAtEndOfCycle: kind === BillingOperationKind.CANCEL,
        providerCurrentPeriodStart: null,
        providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
        providerPendingEffectiveAt: null,
        previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
        subscriptionId: "subscription-1",
      });
      operation = recorded!;
    }

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: kind === BillingOperationKind.CANCEL ? "growth" : planHandle,
      providerReference: "gid://shopify/AppSubscription/enriched",
      cancelAtEndOfCycle: kind === BillingOperationKind.CANCEL,
    });

    expect(operation).toMatchObject({
      state: BillingOperationState.CONFIRMED,
      providerReference: "gid://shopify/AppSubscription/enriched",
    });
  });

  it("does not enrich confirmed-null operations when multiple confirmed outcomes match", async () => {
    const harness = operationHarness();
    const first = await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: "lifecycle-1",
    });
    const second = await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-2",
      targetPlanHandle: "growth",
      lifecycleEventId: "lifecycle-2",
    });
    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "growth",
      providerReference: null,
      cancelAtEndOfCycle: false,
    });

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/ambiguous",
      cancelAtEndOfCycle: false,
    });

    expect(first.providerReference).toBeNull();
    expect(second.providerReference).toBeNull();
  });

  it("does not enrich a confirmed-null operation while an open matching command remains", async () => {
    const harness = operationHarness();
    const confirmed = await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      targetPlanHandle: "growth",
      lifecycleEventId: "lifecycle-confirmed",
    });
    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "growth",
      providerReference: null,
      cancelAtEndOfCycle: false,
    });
    await harness.service.recordInitialPaidIntent(harness.transaction as never, {
      shopId: "shop-1",
      subscriptionId: "subscription-2",
      targetPlanHandle: "growth",
      lifecycleEventId: "lifecycle-open",
    });

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/open-ambiguous",
      cancelAtEndOfCycle: false,
    });

    expect(confirmed).toMatchObject({
      state: BillingOperationState.CONFIRMED,
      providerReference: null,
    });
    expect(harness.operations[1]).toMatchObject({
      state: BillingOperationState.INITIATING,
      providerReference: null,
    });
  });

  it("leaves paid switch reconciliation unresolved when multiple operations match", async () => {
    const harness = operationHarness();
    for (const end of ["2026-10-31T00:00:00.000Z", "2026-11-30T00:00:00.000Z"]) {
      await harness.service.recordHostedPlanChange(harness.transaction as never, {
        shopId: "shop-1",
        requestedPlanHandle: "scale",
        previousPlanHandle: "growth",
        providerReference: null,
        result: "pending",
        cancelAtEndOfCycle: false,
        providerCurrentPeriodStart: null,
        providerCurrentPeriodEnd: end,
        providerPendingEffectiveAt: end,
        previousCurrentPeriodEnd: new Date(end),
        subscriptionId: "subscription-1",
      });
    }

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "scale",
      providerReference: null,
      cancelAtEndOfCycle: false,
    });

    expect(harness.operations).toHaveLength(2);
    expect(harness.operations.every((operation) =>
      operation.state === BillingOperationState.AWAITING_CONFIRMATION,
    )).toBe(true);
  });

  it("uses an exact provider reference to disambiguate same-plan switches", async () => {
    const harness = operationHarness();
    for (const [boundary, providerReference] of [
      ["2026-10-31T00:00:00.000Z", "gid://shopify/AppSubscription/1"],
      ["2026-11-30T00:00:00.000Z", "gid://shopify/AppSubscription/2"],
    ]) {
      await harness.service.recordHostedPlanChange(harness.transaction as never, {
        shopId: "shop-1",
        requestedPlanHandle: "scale",
        previousPlanHandle: "growth",
        providerReference,
        result: "pending",
        cancelAtEndOfCycle: false,
        providerCurrentPeriodStart: null,
        providerCurrentPeriodEnd: boundary,
        providerPendingEffectiveAt: boundary,
        previousCurrentPeriodEnd: new Date(boundary),
        subscriptionId: "subscription-1",
      });
    }

    await harness.service.reconcileActiveSubscription(harness.transaction as never, {
      shopId: "shop-1",
      providerPlanHandle: "scale",
      providerReference: "gid://shopify/AppSubscription/2",
      cancelAtEndOfCycle: false,
    });

    expect(harness.operations.map((operation) => operation.state)).toEqual([
      BillingOperationState.AWAITING_CONFIRMATION,
      BillingOperationState.CONFIRMED,
    ]);
  });

  it("preserves a previously attached provider reference when confirming without new evidence", async () => {
    const harness = operationHarness();
    const operation = await harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "scale",
      previousPlanHandle: "growth",
      providerReference: "gid://shopify/AppSubscription/1",
      result: "pending",
      cancelAtEndOfCycle: false,
      providerCurrentPeriodStart: null,
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: "2026-10-31T00:00:00.000Z",
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    });
    const confirmed = await harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "scale",
      previousPlanHandle: "growth",
      providerReference: null,
      result: "current",
      cancelAtEndOfCycle: false,
      providerCurrentPeriodStart: null,
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: "2026-10-31T00:00:00.000Z",
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    });

    expect(confirmed).toMatchObject({
      id: operation?.id,
      state: BillingOperationState.CONFIRMED,
      providerReference: "gid://shopify/AppSubscription/1",
    });
  });

  it("records and uniquely confirms cancellation without a stable provider reference", async () => {
    const harness = operationHarness();
    const operation = await harness.service.recordHostedPlanChange(harness.transaction as never, {
      shopId: "shop-1",
      requestedPlanHandle: "free",
      previousPlanHandle: "growth",
      providerReference: null,
      result: "mismatch",
      cancelAtEndOfCycle: true,
      providerCurrentPeriodStart: null,
      providerCurrentPeriodEnd: "2026-10-31T00:00:00.000Z",
      providerPendingEffectiveAt: null,
      previousCurrentPeriodEnd: new Date("2026-10-31T00:00:00.000Z"),
      subscriptionId: "subscription-1",
    });

    expect(operation).toMatchObject({
      kind: BillingOperationKind.CANCEL,
      state: BillingOperationState.CONFIRMED,
      providerReference: null,
    });
    expect(harness.operations).toHaveLength(1);
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
      state: BillingOperationState.INITIATING,
      merchantPricingUsageEventId: "usage-bronze",
      recoveryCreditPurchaseId: "purchase-1",
      quotedAmountMinor: 2500,
      quotedCurrency: "USD",
      providerReference: null,
    });
  });

  it("does not invent a one-time charge for a zero-cost provider meter", async () => {
    const harness = operationHarness();
    await expect(harness.service.recordOneTimeChargeIntent(harness.transaction as never, {
      shopId: "shop-1",
      purchaseId: "purchase-1",
      providerQuantityBefore: 0,
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
