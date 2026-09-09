import { describe, expect, it, vi } from "vitest";
import { BILLING_SYSTEM_MESSAGE_CODES } from "@modainteract/moda-interact-shared/billing";

import { BillingService } from "../../../app/services/billing/billing.service";
import { getMerchantSystemMessageAction } from "../../../app/services/merchant-support/system-message-actions";

const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");

function providerSubscription(overrides: Record<string, unknown> = {}) {
  return {
    provider: "SHOPIFY",
    planHandle: "growth",
    usageEventHandles: ["message-meter"],
    pendingPlanHandle: null,
    pendingEffectiveAt: null,
    status: "ACTIVE",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-1",
    providerUsageSnapshot: [],
    ...overrides,
  };
}

function createDatabase({ plan = null, pendingPlan = null, current = null } = {}) {
  const state = { current };
  const subscription = {
    findUnique: vi.fn().mockImplementation(async () => state.current),
    upsert: vi.fn().mockImplementation(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      state.current = { id: "subscription-1", ...(state.current ?? create), ...update };
      return state.current;
    }),
  };
  const billingPlan = {
    findUnique: vi.fn().mockImplementation(async ({ where }: { where: { shopifyPlanHandle: string } }) => {
      if (where.shopifyPlanHandle === "growth") return plan;
      if (where.shopifyPlanHandle === "starter") return pendingPlan;
      return null;
    }),
  };
  const billingPeriod = {
    upsert: vi.fn().mockResolvedValue({ id: "period-1", periodStart, periodEnd }),
  };
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }) },
    subscription,
    billingPlan,
    billingPeriod,
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({ subscription, billingPlan, billingPeriod })),
  };
  return { database, state };
}

describe("BillingService subscription projection", () => {
  it("persists the canonical subscription-ended code that maps to the billing CTA", async () => {
    const current = {
      status: "ACTIVE",
      observedShopifyPlanHandle: "growth",
      providerSubscriptionId: "provider-1",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
    };
    const subscription = {
      findUnique: vi.fn().mockResolvedValue(current),
      upsert: vi.fn().mockResolvedValue({}),
    };
    const persistenceQueryRaw = vi.fn()
      .mockResolvedValueOnce([{ defaultLanguageTag: "en-US" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "thread-1" }])
      .mockResolvedValueOnce([{ id: "message-1" }]);
    const persistenceTransaction = {
      $queryRaw: persistenceQueryRaw,
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    const database = {
      shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }) },
      $transaction: vi.fn()
        .mockImplementationOnce(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
          subscription,
        }))
        .mockImplementationOnce(async (callback: (transaction: unknown) => Promise<unknown>) => callback(persistenceTransaction)),
    };
    const service = new BillingService(
      { getActiveSubscription: vi.fn().mockResolvedValue(null) },
      database as never,
    );

    await service.syncSubscription("shop-1");

    const messageInsert = persistenceQueryRaw.mock.calls[3][0];
    const persistedSystemCode = messageInsert.values.find(
      (value: unknown) => typeof value === "string" && value.startsWith("BILLING_"),
    );
    expect(persistedSystemCode).toBe(BILLING_SYSTEM_MESSAGE_CODES.SUBSCRIPTION_ENDED);
    expect(persistedSystemCode).toBe("BILLING_SUBSCRIPTION_ENDED");
    expect(getMerchantSystemMessageAction(persistedSystemCode)).toEqual({
      href: "/app/billing",
      labelKey: "billing.viewPlans",
    });
    expect(getMerchantSystemMessageAction("SUBSCRIPTION_ENDED")).toBeNull();
  });

  it("persists a mapped free plan without requiring a usage meter", async () => {
    const { database, state } = createDatabase({
      plan: { id: "free-1", shopifyPlanHandle: "growth", kind: "FREE", active: true, shopifyUsageEventHandle: null },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "ACTIVE", planId: "free-1", observedShopifyPlanHandle: "growth" });
    expect(database.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId_periodStart_periodEnd: { shopId: "shop-1", periodStart, periodEnd } },
    }));
  });

  it("fails closed when a paid plan omits its configured usage meter", async () => {
    const { database, state } = createDatabase({
      plan: { id: "paid-1", shopifyPlanHandle: "growth", kind: "PAID_METERED", active: true, shopifyUsageEventHandle: "message-meter" },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: [] })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "SYNC_ERROR", lastSyncErrorCode: "MISSING_USAGE_METER" });
  });

  it("persists a mapped paid plan and clears stale sync errors", async () => {
    const { database, state } = createDatabase({
      current: { id: "subscription-1", shopId: "shop-1", status: "SYNC_ERROR", lastSyncErrorCode: "MISSING_USAGE_METER" },
      plan: { id: "paid-1", shopifyPlanHandle: "growth", kind: "PAID_METERED", active: true, shopifyUsageEventHandle: "message-meter" },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ status: "TRIALING" })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({
      status: "TRIALING",
      planId: "paid-1",
      observedShopifyPlanHandle: "growth",
      billingPeriodId: "period-1",
      lastSyncErrorCode: null,
      lastSyncErrorAt: null,
    });
    expect(database.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "OPEN" }),
    }));
  });

  it("treats an inactive mapped plan as unmapped", async () => {
    const { database, state } = createDatabase({
      plan: { id: "growth-1", shopifyPlanHandle: "growth", kind: "FREE", active: false },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "UNMAPPED", planId: null, lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE" });
  });

  it("persists an unknown current Shopify handle as unmapped", async () => {
    const { database, state } = createDatabase();
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ planHandle: "unknown" })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "UNMAPPED", planId: null, observedShopifyPlanHandle: "unknown", lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE" });
  });

  it("maps a pending plan and stores the current cycle end as its effective boundary", async () => {
    const { database, state } = createDatabase({
      plan: { id: "growth-1", shopifyPlanHandle: "growth", kind: "FREE", active: true },
      pendingPlan: { id: "starter-1", shopifyPlanHandle: "starter", active: true },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ pendingPlanHandle: "starter", pendingEffectiveAt: periodEnd })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ pendingShopifyPlanHandle: "starter", pendingPlanId: "starter-1", pendingEffectiveAt: periodEnd });
  });

  it("stores an unknown pending handle without inventing a pending plan id", async () => {
    const { database, state } = createDatabase({
      plan: { id: "growth-1", shopifyPlanHandle: "growth", kind: "FREE", active: true },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ pendingPlanHandle: "unknown-pending" })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ pendingShopifyPlanHandle: "unknown-pending", pendingPlanId: null });
  });

  it("projects trial status and leaves period fields null when Shopify omits the cycle", async () => {
    const { database, state } = createDatabase({
      plan: { id: "free-1", shopifyPlanHandle: "growth", kind: "FREE", active: true },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ status: "TRIALING", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: new Date("2026-09-15T00:00:00.000Z") })) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "TRIALING", trialEndsAt: new Date("2026-09-15T00:00:00.000Z"), billingPeriodId: null });
    expect(database.billingPeriod.upsert).not.toHaveBeenCalled();
  });

  it("projects no contract and clears current and pending plan state", async () => {
    const { database, state } = createDatabase({
      current: { id: "subscription-1", shopId: "shop-1", status: "ACTIVE", observedShopifyPlanHandle: "growth", providerSubscriptionId: "provider-1" },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(null) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "NO_CONTRACT", planId: null, observedShopifyPlanHandle: null, pendingPlanId: null, pendingShopifyPlanHandle: null });
  });

  it("clears a stale sync error after a valid projection", async () => {
    const { database, state } = createDatabase({
      current: { id: "subscription-1", shopId: "shop-1", status: "SYNC_ERROR", lastSyncErrorCode: "MISSING_USAGE_METER" },
      plan: { id: "growth-1", shopifyPlanHandle: "growth", kind: "FREE", active: true },
    });
    const service = new BillingService({ getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription()) }, database as never);

    await service.syncSubscription("shop-1");

    expect(state.current).toMatchObject({ status: "ACTIVE", lastSyncErrorCode: null, lastSyncErrorAt: null });
  });
});

function createRecoveryCreditPurchaseDatabase(planOverrides: Record<string, unknown> = {}) {
  const purchases = new Map<string, Record<string, unknown>>();
  const usageEvents: Record<string, unknown>[] = [];
  const plan = {
    id: "growth-1",
    shopifyPlanHandle: "growth",
    kind: "PAID_METERED",
    active: true,
    recoveryCreditPackEnabled: true,
    recoveryCreditsPerPack: 100,
    shopifyRecoveryCreditPackEventHandle: "credit-pack-meter",
    shopifyUsageEventHandle: "message-meter",
    ...planOverrides,
  };
  const database = {
    shop: { findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }) },
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        status: "ACTIVE",
        billingPeriodId: "period-1",
        plan,
      }),
    },
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      recoveryCreditPurchase: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => purchases.get(where.id) ?? null),
        create: vi.fn().mockImplementation(async ({ data, include }: { data: Record<string, unknown>; include: unknown }) => {
          const purchase = { ...data, status: "PENDING_BILLING", usageEvent: usageEvents.at(-1) };
          purchases.set(String(data.id), purchase);
          return purchase;
        }),
      },
      usageEvent: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          usageEvents.push(data);
          return data;
        }),
      },
    })),
  };
  return { database, purchases, usageEvents };
}

describe("BillingService recovery credit packs", () => {
  it.each([
    ["FREE", { kind: "FREE", shopifyUsageEventHandle: null }],
    ["PAID_METERED", { kind: "PAID_METERED" }],
  ])("creates a pending pack request for a mapped %s plan", async (_name, planOverrides) => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase(planOverrides);
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);

    const purchase = await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "11111111-1111-4111-8111-111111111111");

    expect(purchase).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", creditsGranted: 100, status: "PENDING_BILLING" });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      metric: "RECOVERY_CREDIT_PACK_PURCHASE",
      quantity: 1,
      shopifyReportState: "PENDING",
      shopifyEventHandle: "credit-pack-meter",
      billingPeriodId: "period-1",
    });
  });

  it("returns the existing purchase without creating another usage event", async () => {
    const { database, purchases, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);
    const purchaseId = "22222222-2222-4222-8222-222222222222";

    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", purchaseId);
    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", purchaseId);

    expect(purchases).toHaveLength(1);
    expect(usageEvents).toHaveLength(1);
  });

  it("allows repeated purchases with different purchase IDs", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter", "credit-pack-meter"] })) };
    const service = new BillingService(provider, database as never);

    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "33333333-3333-4333-8333-333333333333");
    await service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "44444444-4444-4444-8444-444444444444");

    expect(usageEvents).toHaveLength(2);
  });

  it("fails closed without creating an event when the pack meter is not verified", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const provider = { getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({ usageEventHandles: ["message-meter"] })) };
    const service = new BillingService(provider, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "55555555-5555-4555-8555-555555555555"))
      .rejects.toThrow("could not be verified");
    expect(usageEvents).toHaveLength(0);
  });

  it("rejects client-supplied invalid purchase identities before persistence", async () => {
    const { database, usageEvents } = createRecoveryCreditPurchaseDatabase();
    const service = new BillingService({ getActiveSubscription: vi.fn() }, database as never);

    await expect(service.requestRecoveryCreditPack("shop-1", "BUY_RECOVERY_CREDIT_PACK", "not-a-uuid"))
      .rejects.toThrow("valid recovery credit purchase ID");
    expect(usageEvents).toHaveLength(0);
  });
});
