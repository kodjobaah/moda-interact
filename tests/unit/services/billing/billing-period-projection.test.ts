import {
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
} from "@prisma/client";
import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
} from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it, vi } from "vitest";

import {
  deriveBillingPeriodPhase,
  ensureMappedCurrentBillingPeriodProjection,
  hasDurableBillingPeriod,
  hasMatchingBillingCycle,
  isSafeNonNegativeInteger,
} from "../../../../app/services/billing/billing-period-projection";

const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");

const freePlan = {
  id: "free-plan",
  name: "Free",
  kind: BillingPlanKind.FREE,
  shopifyPlanHandle: "free-handle",
  includedRecoveryConversationAllowance: null,
};

const paidPlan = {
  id: "paid-plan",
  name: "Growth",
  kind: BillingPlanKind.PAID_METERED,
  shopifyPlanHandle: "growth-handle",
  includedRecoveryConversationAllowance: 25,
};

function projectionInput(plan: typeof freePlan | typeof paidPlan = freePlan) {
  return {
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    periodStart,
    periodEnd,
    providerPlanHandle: plan.shopifyPlanHandle,
    plan,
  };
}

function existingPeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: "period-1",
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planId: "free-plan",
    shopifyPlanHandleSnapshot: "free-handle",
    planNameSnapshot: "Free",
    planKindSnapshot: BillingPlanKind.FREE,
    includedRecoveryCreditsGranted: null,
    periodStart,
    periodEnd,
    status: BillingPeriodStatus.OPEN,
    ...overrides,
  };
}

function createTransaction(period: Record<string, unknown> | null, counter: Record<string, unknown> | null = null) {
  const billingPeriod = {
    findUnique: vi.fn().mockResolvedValue(period),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "period-created", ...data })),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...period, ...data })),
  };
  const billingPeriodEntitlementCounter = {
    findUnique: vi.fn().mockResolvedValue(counter),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "counter-created", ...data })),
  };
  return { transaction: { billingPeriod, billingPeriodEntitlementCounter }, billingPeriod, billingPeriodEntitlementCounter };
}

describe("billing-period projection", () => {
  it("creates an OPEN paid period and its included counter in the supplied transaction", async () => {
    const fixture = createTransaction(null);

    const result = await ensureMappedCurrentBillingPeriodProjection(fixture.transaction as never, projectionInput(paidPlan));

    expect(result).toEqual({ kind: "READY", billingPeriodId: "period-created", repaired: false });
    expect(fixture.billingPeriod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        planId: "paid-plan",
        shopifyPlanHandleSnapshot: "growth-handle",
        includedRecoveryCreditsGranted: 25,
        status: BillingPeriodStatus.OPEN,
      }),
    });
    expect(fixture.billingPeriodEntitlementCounter.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        billingPeriodId: "period-created",
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
        grantedQuantity: 25,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      }),
    });
    expect(fixture.billingPeriod.update).not.toHaveBeenCalled();
  });

  it("repairs a compatible null mapping in place and retains the period update", async () => {
    const period = existingPeriod({
      planId: null,
      shopifyPlanHandleSnapshot: null,
      planNameSnapshot: null,
      planKindSnapshot: null,
    });
    const fixture = createTransaction(period);

    const result = await ensureMappedCurrentBillingPeriodProjection(fixture.transaction as never, projectionInput());

    expect(result).toEqual({ kind: "READY", billingPeriodId: "period-1", repaired: true });
    expect(fixture.billingPeriod.update).toHaveBeenCalledWith({
      where: { id: "period-1" },
      data: expect.objectContaining({ planId: "free-plan", status: BillingPeriodStatus.OPEN }),
    });
    expect(fixture.billingPeriod.create).not.toHaveBeenCalled();
  });

  it("creates the missing included counter once for an existing paid period", async () => {
    const period = existingPeriod({
      planId: "paid-plan",
      shopifyPlanHandleSnapshot: "growth-handle",
      planNameSnapshot: "Growth",
      planKindSnapshot: BillingPlanKind.PAID_METERED,
      includedRecoveryCreditsGranted: 25,
    });
    const fixture = createTransaction(period);

    const result = await ensureMappedCurrentBillingPeriodProjection(fixture.transaction as never, projectionInput(paidPlan));

    expect(result).toEqual({ kind: "READY", billingPeriodId: "period-1", repaired: true });
    expect(fixture.billingPeriod.update).toHaveBeenCalledTimes(1);
    expect(fixture.billingPeriodEntitlementCounter.create).toHaveBeenCalledTimes(1);
    expect(fixture.billingPeriodEntitlementCounter.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ billingPeriodId: "period-1", grantedQuantity: 25 }),
    });
  });

  it("does not overwrite a closed period", async () => {
    const fixture = createTransaction(existingPeriod({ status: BillingPeriodStatus.CLOSED }));

    const result = await ensureMappedCurrentBillingPeriodProjection(fixture.transaction as never, projectionInput());

    expect(result).toEqual({ kind: "CONFLICT", billingPeriodId: "period-1", reason: "CLOSED_PERIOD" });
    expect(fixture.billingPeriod.update).not.toHaveBeenCalled();
    expect(fixture.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
  });

  it("conflicts when a FREE period has an included counter", async () => {
    const fixture = createTransaction(existingPeriod(), { shopId: "shop-1", grantedQuantity: 1 });

    const result = await ensureMappedCurrentBillingPeriodProjection(fixture.transaction as never, projectionInput());

    expect(result).toEqual({ kind: "CONFLICT", billingPeriodId: "period-1", reason: "FREE_INCLUDED_COUNTER_PRESENT" });
    expect(fixture.billingPeriod.update).not.toHaveBeenCalled();
  });

  it("conflicts on paid counter arithmetic or grant mismatch without updating", async () => {
    const paidPeriod = existingPeriod({
      planId: "paid-plan",
      shopifyPlanHandleSnapshot: "growth-handle",
      planNameSnapshot: "Growth",
      planKindSnapshot: BillingPlanKind.PAID_METERED,
      includedRecoveryCreditsGranted: 25,
    });
    const fixture = createTransaction(paidPeriod, {
      shopId: "shop-1",
      grantedQuantity: 25,
      committedQuantity: 20,
      reservedQuantity: 4,
      forfeitedQuantity: 2,
    });

    const result = await ensureMappedCurrentBillingPeriodProjection(fixture.transaction as never, projectionInput(paidPlan));

    expect(result).toEqual({ kind: "CONFLICT", billingPeriodId: "period-1", reason: "PAID_COUNTER_MISMATCH" });
    expect(fixture.billingPeriod.update).not.toHaveBeenCalled();
    expect(fixture.billingPeriodEntitlementCounter.create).not.toHaveBeenCalled();
  });

  it.each([null, -1, 1.5])("rejects an invalid paid allowance: %s", async (allowance) => {
    const fixture = createTransaction(null);
    const plan = { ...paidPlan, includedRecoveryConversationAllowance: allowance };

    const result = await ensureMappedCurrentBillingPeriodProjection(fixture.transaction as never, projectionInput(plan as never));

    expect(result).toEqual({ kind: "CONFLICT", billingPeriodId: null, reason: "INVALID_INCLUDED_ALLOWANCE" });
    expect(fixture.billingPeriod.findUnique).not.toHaveBeenCalled();
  });
});

describe("billing-period cycle helpers", () => {
  it("requires durable IDs and period boundaries before matching a cycle", () => {
    const subscription = {
      billingPeriodId: "period-1",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      billingPeriod: { id: "period-1", periodStart, periodEnd },
    };
    const providerSubscription = { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd };

    expect(hasDurableBillingPeriod(subscription)).toBe(true);
    expect(hasMatchingBillingCycle(subscription, providerSubscription, "period-1")).toBe(true);
    expect(hasMatchingBillingCycle(subscription, providerSubscription, "other-period")).toBe(false);
    expect(hasDurableBillingPeriod({ ...subscription, billingPeriod: { ...subscription.billingPeriod, periodEnd: new Date("2026-10-02T00:00:00.000Z") } })).toBe(false);
  });

  it("derives billing phases and accepts only safe non-negative integers", () => {
    expect(deriveBillingPeriodPhase(null)).toBeNull();
    expect(deriveBillingPeriodPhase(periodEnd, new Date(periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS - 1))).toBe("ACTIVE");
    expect(deriveBillingPeriodPhase(periodEnd, new Date(periodEnd.getTime() - 1))).toBe("DRAINING");
    expect(deriveBillingPeriodPhase(periodEnd, periodEnd)).toBe("RECONCILING");
    expect(isSafeNonNegativeInteger(0)).toBe(true);
    expect(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isSafeNonNegativeInteger(-1)).toBe(false);
    expect(isSafeNonNegativeInteger(1.5)).toBe(false);
    expect(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isSafeNonNegativeInteger(null)).toBe(false);
  });
});