import { describe, expect, it, vi } from "vitest";

import {
  HostedPlanChangeService,
  type HostedPlanVerificationFence,
} from "../../../../app/services/billing/hosted-plan-change.service";

const date = new Date("2026-09-12T00:00:00.000Z");

function createHarness({ current = null, pendingPlan = null }: {
  current?: Record<string, unknown> | null;
  pendingPlan?: { id: string; active: boolean } | null;
} = {}) {
  const state: { current: Record<string, unknown> | null } = { current };
  const subscription = {
    findUnique: vi.fn().mockImplementation(async () => state.current),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.current = { ...state.current, ...data };
      return state.current;
    }),
    updateMany: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (!state.current) return { count: 0 };
      state.current = { ...state.current, ...data };
      return { count: 1 };
    }),
  };
  const billingPlan = { findUnique: vi.fn().mockResolvedValue(pendingPlan) };
  const transaction = {
    subscription,
    billingPlan,
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const database = {
    subscription,
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  return {
    service: new HostedPlanChangeService(database as never),
    state,
    subscription,
    billingPlan,
    transaction,
  };
}

function hostedFence(overrides: Record<string, unknown> = {}): HostedPlanVerificationFence {
  return {
    id: "subscription-1",
    updatedAt: date,
    status: "ACTIVE" as never,
    observedShopifyPlanHandle: "growth",
    planId: "growth-id",
    billingPeriodId: "period-1",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    pendingShopifyPlanHandle: "old-pending",
    pendingPlanId: "old-pending-id",
    pendingEffectiveAt: null,
    nextReconcileAt: date,
    lastSyncedAt: date,
    lastSyncErrorCode: null,
    lastSyncErrorAt: null,
    ...overrides,
  };
}

function activeState(overrides: Record<string, unknown> = {}) {
  return {
    status: "ACTIVE_SUBSCRIPTION",
    subscription: {
      planHandle: "growth",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelAtEndOfCycle: false,
      pendingUpdate: null,
      ...overrides,
    },
  } as never;
}

describe("HostedPlanChangeService", () => {
  it("returns a null pre-provider fence when no durable subscription exists", async () => {
    const { service, subscription } = createHarness();
    await expect(service.getHostedPlanVerificationFence("shop-1")).resolves.toBeNull();
    expect(subscription.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["current", "growth", null],
    ["pending", "starter", { planHandle: "starter", effectiveAt: "2026-10-01T00:00:00.000Z" }],
    ["mismatch", "scale", null],
  ] as const)("classifies a %s provider result without changing protected lifecycle fields", async (expectedResult, requestedPlanHandle, pendingUpdate) => {
    const current = {
      ...hostedFence(),
      status: "ACTIVE",
      nextReconcileAt: date,
    };
    const pendingPlan = pendingUpdate ? { id: "starter-id", active: true } : null;
    const { service, state, subscription, billingPlan } = createHarness({ current, pendingPlan });

    const result = await service.recordHostedPlanChangeReturn({
      shopId: "shop-1",
      requestedPlanHandle,
      state: activeState({ pendingUpdate }) ,
      verificationFence: hostedFence(),
    });

    expect(result.result).toBe(expectedResult);
    expect(state.current?.planId).toBe("growth-id");
    expect(state.current?.billingPeriodId).toBe("period-1");
    if (expectedResult === "mismatch") {
      expect(subscription.update).not.toHaveBeenCalled();
      expect(billingPlan.findUnique).not.toHaveBeenCalled();
    }
  });

  it("returns no_active without creating state when the fence and durable state are absent", async () => {
    const { service, subscription, billingPlan } = createHarness();
    await expect(service.recordHostedPlanChangeReturn({
      shopId: "shop-1",
      requestedPlanHandle: "growth",
      state: { status: "NO_ACTIVE_SUBSCRIPTION", subscription: null },
      verificationFence: null,
    })).resolves.toEqual({ result: "no_active", subscriptionId: null, nextReconcileAt: null });
    expect(subscription.update).not.toHaveBeenCalled();
    expect(billingPlan.findUnique).not.toHaveBeenCalled();
  });

  it("fences changed durable content even when updatedAt is identical", async () => {
    const current = { ...hostedFence(), status: "ACTIVE" };
    const { service, state, subscription, billingPlan } = createHarness({ current });
    current.planId = "starter-id";

    await expect(service.recordHostedPlanChangeReturn({
      shopId: "shop-1",
      requestedPlanHandle: "growth",
      state: activeState(),
      verificationFence: hostedFence(),
    })).resolves.toEqual({ result: "unverified", subscriptionId: "subscription-1", nextReconcileAt: null });
    expect(state.current?.planId).toBe("starter-id");
    expect(subscription.update).not.toHaveBeenCalled();
    expect(billingPlan.findUnique).not.toHaveBeenCalled();
  });

  it("records only the guarded Partner-error retry and follows the shared lock order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(date);
    const current = { ...hostedFence(), status: "ACTIVE" };
    const { service, state, subscription, transaction } = createHarness({ current });
    try {
      const result = await service.recordHostedPlanVerificationFailure("shop-1", hostedFence());
      expect(result).toMatchObject({ subscriptionId: "subscription-1" });
      expect(state.current).toMatchObject({
        planId: "growth-id",
        billingPeriodId: "period-1",
        lastSyncErrorCode: "PARTNER_API_ERROR",
        nextReconcileAt: new Date(date.getTime() + 60_000),
      });
      expect(subscription.updateMany).toHaveBeenCalledTimes(1);
      const lockStatements = transaction.$queryRaw.mock.calls.map(([query]) => (query as { sql?: string }).sql);
      expect(lockStatements[0]).toContain('FROM "shopify"."ShopSettings"');
      expect(lockStatements[1]).toContain('FROM "billing"."Subscription"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a changed fence or manufacture state when the subscription is absent", async () => {
    const current = { ...hostedFence({ pendingPlanId: "new-pending" }), status: "ACTIVE" };
    const changed = createHarness({ current });
    await expect(changed.service.recordHostedPlanVerificationFailure("shop-1", hostedFence())).resolves.toBeNull();
    expect(changed.subscription.updateMany).not.toHaveBeenCalled();

    const absent = createHarness();
    await expect(absent.service.recordHostedPlanVerificationFailure("shop-1", null)).resolves.toBeNull();
    expect(absent.subscription.updateMany).not.toHaveBeenCalled();
  });
});