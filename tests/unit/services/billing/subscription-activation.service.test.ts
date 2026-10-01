import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";

import { SubscriptionActivationService } from "../../../../app/services/billing/subscription-activation.service";

const plan = {
  id: "free-1",
  shopifyPlanHandle: "free",
  kind: BillingPlanKind.FREE,
  active: true,
};

function createHarness({
  kind = BillingPlanKind.FREE,
  currentSubscription = null,
  topUpEnabled = false,
}: {
  kind?: BillingPlanKind;
  currentSubscription?: Record<string, unknown> | null;
  topUpEnabled?: boolean;
} = {}) {
  const resolvedPlan = { ...plan, kind };
  const state: { currentSubscription: Record<string, unknown> | null } = { currentSubscription };
  const subscription = {
    findUnique: vi.fn().mockImplementation(async () => state.currentSubscription),
    upsert: vi.fn().mockImplementation(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      state.currentSubscription = { ...(state.currentSubscription ?? create), ...update, id: "subscription-1" };
      return state.currentSubscription;
    }),
    update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.currentSubscription = { ...state.currentSubscription, ...data };
      return state.currentSubscription;
    }),
  };
  const transaction = {
    subscription,
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const database = {
    $transaction: vi.fn(async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction)),
  };
  const planResolutionService = {
    resolveOrMaterializeBillingPlan: vi.fn().mockResolvedValue({ kind: "READY", plan: resolvedPlan, materialized: false }),
    readRecoveryCreditTopUpConfiguration: vi.fn().mockResolvedValue({ enabled: topUpEnabled, creditsPerPack: topUpEnabled ? 100 : null }),
  };
  return {
    service: new SubscriptionActivationService(database as never, planResolutionService as never),
    database,
    planResolutionService,
    state,
    subscription,
    transaction,
    resolvedPlan,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SubscriptionActivationService", () => {
  it("prepares an initial Free selection and preserves the ShopSettings then Subscription lock order", async () => {
    const { service, state, subscription, transaction } = createHarness();

    const activation = await service.prepareFreeActivation("shop-1", "free");

    expect(activation).toMatchObject({ plan, mode: "INITIAL", token: { planKind: BillingPlanKind.FREE } });
    expect(Object.isFrozen(activation?.token)).toBe(true);
    expect(state.currentSubscription).toMatchObject({
      status: SubscriptionProjectionStatus.NO_CONTRACT,
      planId: null,
      pendingShopifyPlanHandle: "free",
      pendingPlanId: "free-1",
    });
    expect(subscription.upsert).toHaveBeenCalledTimes(1);
    const lockStatements = transaction.$queryRaw.mock.calls.map(([query]) => (query as { sql?: string }).sql);
    expect(lockStatements[0]).toContain('FROM "shopify"."ShopSettings"');
    expect(lockStatements[0]).toContain("FOR UPDATE");
    expect(lockStatements[1]).toContain('FROM "billing"."Subscription"');
    expect(lockStatements[1]).toContain("FOR UPDATE");
  });

  it("allows a verified Free replay without replacing the current selection", async () => {
    const existing = {
      id: "subscription-1",
      status: SubscriptionProjectionStatus.ACTIVE,
      planId: "free-1",
      observedShopifyPlanHandle: "free",
      pendingPlanId: "pending-1",
    };
    const { service, subscription } = createHarness({ currentSubscription: existing });

    await expect(service.prepareFreeActivation("shop-1", "free")).resolves.toEqual({
      plan,
      mode: "VERIFIED_REPLAY",
      token: null,
    });
    expect(subscription.upsert).not.toHaveBeenCalled();
  });

  it("records Paid activation intent without finalizing the subscription", async () => {
    const { service, state, subscription } = createHarness({ kind: BillingPlanKind.PAID_METERED });

    const activation = await service.preparePaidActivation("shop-1", "free");

    expect(activation).toMatchObject({ mode: "INITIAL", token: { planKind: BillingPlanKind.PAID_METERED } });
    expect(state.currentSubscription).toMatchObject({
      status: SubscriptionProjectionStatus.NO_CONTRACT,
      planId: null,
      pendingPlanId: "free-1",
      pendingShopifyPlanHandle: "free",
    });
    expect(subscription.upsert).toHaveBeenCalledTimes(1);
  });

  it("leaves a stale guarded retry as a no-op", async () => {
    const expected = {
      subscriptionId: "subscription-1",
      pendingPlanId: "free-1",
      pendingShopifyPlanHandle: "free",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
    };
    const { service, subscription } = createHarness({
      currentSubscription: {
        id: "subscription-1",
        ...expected,
        pendingPlanId: "newer-plan",
      },
    });

    await expect(service.scheduleInitialFreeReconciliationIfCurrent({
      shopId: "shop-1",
      expected,
      nextReconcileAt: new Date("2026-09-12T00:01:00.000Z"),
    })).resolves.toBeNull();
    expect(subscription.update).not.toHaveBeenCalled();
  });

  it("records a Partner-error retry only for the matching current token", async () => {
    const nextReconcileAt = new Date("2026-09-12T00:01:00.000Z");
    const partnerErrorAt = new Date("2026-09-12T00:00:30.000Z");
    const expected = {
      subscriptionId: "subscription-1",
      pendingPlanId: "free-1",
      pendingShopifyPlanHandle: "free",
      pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
      nextReconcileAt: new Date("2026-09-12T00:00:00.000Z"),
    };
    const { service, subscription } = createHarness({
      currentSubscription: { id: expected.subscriptionId, ...expected },
    });

    await expect(service.scheduleInitialFreeReconciliationIfCurrent({
      shopId: "shop-1",
      expected,
      nextReconcileAt,
      partnerErrorAt,
    })).resolves.toEqual({ subscriptionId: "subscription-1", nextReconcileAt });
    expect(subscription.update).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: {
        nextReconcileAt,
        lastSyncErrorCode: "PARTNER_API_ERROR",
        lastSyncErrorAt: partnerErrorAt,
      },
      select: { id: true, nextReconcileAt: true },
    });
  });

  it("schedules Free completion at the existing drain-window boundary", async () => {
    const now = new Date("2026-09-14T00:00:00.000Z");
    const currentPeriodEnd = new Date("2026-10-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { service, subscription } = createHarness({
      topUpEnabled: true,
      currentSubscription: {
        id: "subscription-1",
        status: SubscriptionProjectionStatus.ACTIVE,
        planId: "free-1",
        observedShopifyPlanHandle: "free",
        pendingShopifyPlanHandle: "free",
        pendingPlanId: "free-1",
        pendingEffectiveAt: new Date("2026-09-12T00:00:00.000Z"),
        currentPeriodEnd,
        plan,
      },
    });

    await expect(service.completeFreeActivation("shop-1", "free")).resolves.toEqual({
      subscriptionId: "subscription-1",
      nextReconcileAt: new Date(currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS),
    });
    expect(subscription.update).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: {
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
        nextReconcileAt: new Date(currentPeriodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS),
      },
    });
  });
});