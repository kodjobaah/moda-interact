import { describe, expect, it, vi } from "vitest";
import {
  BillingPeriodStatus,
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";

import { SubscriptionSyncService } from "../../../../app/services/billing/subscription-sync.service";

const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");

function activeProviderSubscription(overrides: Record<string, unknown> = {}) {
  return {
    provider: "SHOPIFY",
    planHandle: "growth",
    billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: {
      handle: "growth",
      description: null,
      price: { amount: "10", currency: "USD" },
    },
    pendingFlatRatePlan: null,
    usageItems: [],
    usageEventHandles: [],
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

type SyncServiceOptions = {
  providerSubscription?: Record<string, unknown> | null;
  currentSubscription?: Record<string, unknown> | null;
  resolution?: { kind: string; plan?: Record<string, unknown>; materialized?: boolean };
  topUpConfiguration?: { enabled: boolean; creditsPerPack: number | null };
};

function createSyncService({
  providerSubscription = null,
  currentSubscription = null,
  resolution = { kind: "UNKNOWN_CATALOGUE_PLAN" },
  topUpConfiguration = { enabled: false, creditsPerPack: null },
}: SyncServiceOptions = {}) {
  let transactionCommitted = false;
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    subscription: {
      findUnique: vi.fn().mockResolvedValue(currentSubscription),
      upsert: vi.fn().mockResolvedValue({ id: "subscription-1" }),
    },
    billingPlan: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "period-1" }),
      update: vi.fn().mockResolvedValue({ id: "period-1" }),
      upsert: vi.fn().mockResolvedValue({ id: "period-1" }),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const database = {
    shop: {
      findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }),
    },
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => {
      const result = await callback(transaction);
      transactionCommitted = true;
      return result;
    }),
  };
  const provider = {
    getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription),
  };
  const planResolutionService = {
    resolveOrMaterializeBillingPlan: vi.fn().mockResolvedValue(resolution),
    readRecoveryCreditTopUpConfiguration: vi.fn().mockResolvedValue(topUpConfiguration),
  };
  const subscriptionActivationService = {
    finalizeInitialPaidActivation: vi.fn().mockResolvedValue({ id: "subscription-1" }),
  };
  const subscriptionEndedNotificationService = {
    notifySubscriptionEnded: vi.fn().mockImplementation(async () => {
      expect(transactionCommitted).toBe(true);
    }),
  };

  return {
    service: new SubscriptionSyncService(
      provider as never,
      database as never,
      planResolutionService as never,
      subscriptionActivationService as never,
      subscriptionEndedNotificationService as never,
    ),
    transaction,
    database,
    provider,
    planResolutionService,
    subscriptionActivationService,
    subscriptionEndedNotificationService,
  };
}

describe("SubscriptionSyncService", () => {
  it("rejects a stale no-contract token without writing", async () => {
    const currentSubscription = {
      id: "subscription-current",
      status: SubscriptionProjectionStatus.NO_CONTRACT,
      planId: null,
      observedShopifyPlanHandle: null,
      pendingPlanId: "pending-plan",
      pendingShopifyPlanHandle: "starter",
      pendingEffectiveAt: periodStart,
      nextReconcileAt: periodStart,
    };
    const { service, transaction, provider, subscriptionEndedNotificationService } = createSyncService({
      currentSubscription,
    });

    const result = await service.syncSubscription("shop-1", {
      subscriptionId: "stale-subscription",
      pendingPlanId: "pending-plan",
      pendingShopifyPlanHandle: "starter",
      pendingEffectiveAt: periodStart,
      nextReconcileAt: periodStart,
    });

    expect(result).toBeNull();
    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
    expect(transaction.subscription.upsert).not.toHaveBeenCalled();
    expect(subscriptionEndedNotificationService.notifySubscriptionEnded).not.toHaveBeenCalled();
  });

  it("commits no-contract projection before notifying an ended subscription", async () => {
    const { service, transaction, subscriptionEndedNotificationService } = createSyncService({
      currentSubscription: {
        id: "subscription-1",
        status: SubscriptionProjectionStatus.ACTIVE,
        observedShopifyPlanHandle: "growth",
        providerSubscriptionId: "provider-1",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        trialEndsAt: null,
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
        nextReconcileAt: null,
        planId: "plan-1",
      },
    });

    await service.syncSubscription("shop-1");

    expect(transaction.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        planId: null,
        cancelAtPeriodEnd: false,
        providerSubscriptionId: null,
      }),
    }));
    expect(subscriptionEndedNotificationService.notifySubscriptionEnded).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ lifecycleIdentity: "provider:provider-1" }),
    );
  });

  it("uses raw BillingPeriod upsert for an unmapped provider plan", async () => {
    const { service, transaction } = createSyncService({
      providerSubscription: activeProviderSubscription(),
    });

    await service.syncSubscription("shop-1");

    expect(transaction.billingPeriod.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { status: BillingPeriodStatus.OPEN },
      create: expect.objectContaining({
        planId: null,
        shopifyPlanHandleSnapshot: "growth",
      }),
    }));
    expect(transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(transaction.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        status: SubscriptionProjectionStatus.UNMAPPED,
        lastSyncErrorCode: "UNMAPPED_PLAN_HANDLE",
      }),
    }));
  });

  it("uses mapped projection helper path for a valid operational plan", async () => {
    const plan = {
      id: "plan-1",
      name: "Growth",
      kind: BillingPlanKind.FREE,
      active: true,
      shopifyPlanHandle: "growth",
      includedRecoveryConversationAllowance: null,
    };
    const { service, transaction } = createSyncService({
      providerSubscription: activeProviderSubscription(),
      resolution: { kind: "READY", plan, materialized: false },
    });

    await service.syncSubscription("shop-1");

    expect(transaction.billingPeriod.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        planId: "plan-1",
        shopifyPlanHandleSnapshot: "growth",
      }),
    }));
    expect(transaction.billingPeriod.upsert).not.toHaveBeenCalled();
  });

  it("suppresses ordinary period projection while preserving initial Paid intent", async () => {
    const plan = {
      id: "paid-plan",
      name: "Growth Paid",
      kind: BillingPlanKind.PAID_METERED,
      active: true,
      shopifyPlanHandle: "growth",
      shopifyUsageEventHandle: "usage-meter",
      includedRecoveryConversationAllowance: 20,
    };
    const pendingEffectiveAt = new Date("2026-09-15T00:00:00.000Z");
    const nextReconcileAt = new Date("2026-09-15T00:05:00.000Z");
    const { service, transaction } = createSyncService({
      providerSubscription: activeProviderSubscription({ usageEventHandles: ["usage-meter"] }),
      currentSubscription: {
        id: "subscription-1",
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        planId: null,
        observedShopifyPlanHandle: null,
        pendingShopifyPlanHandle: "starter",
        pendingPlanId: "pending-plan",
        pendingEffectiveAt,
        nextReconcileAt,
      },
      resolution: { kind: "READY", plan, materialized: false },
    });

    await service.syncSubscription("shop-1");

    expect(transaction.billingPeriod.findUnique).not.toHaveBeenCalled();
    expect(transaction.billingPeriod.upsert).not.toHaveBeenCalled();
    expect(transaction.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        pendingShopifyPlanHandle: "starter",
        pendingPlanId: "pending-plan",
        pendingEffectiveAt,
        nextReconcileAt,
      }),
    }));
  });

  it("passes the active transaction to initial Paid finalisation without nesting", async () => {
    const paidToken = {
      subscriptionId: "subscription-1",
      pendingPlanId: "paid-plan",
      pendingShopifyPlanHandle: "growth",
      pendingEffectiveAt: periodStart,
      nextReconcileAt: periodStart,
      planKind: BillingPlanKind.PAID_METERED,
    };
    const { service, transaction, database, subscriptionActivationService } = createSyncService({
      providerSubscription: activeProviderSubscription(),
      currentSubscription: {
        id: "subscription-1",
        status: SubscriptionProjectionStatus.NO_CONTRACT,
        planId: null,
        observedShopifyPlanHandle: null,
        pendingShopifyPlanHandle: paidToken.pendingShopifyPlanHandle,
        pendingPlanId: paidToken.pendingPlanId,
        pendingEffectiveAt: paidToken.pendingEffectiveAt,
        nextReconcileAt: paidToken.nextReconcileAt,
      },
      resolution: {
        kind: "READY",
        plan: { id: "paid-plan", kind: BillingPlanKind.PAID_METERED },
        materialized: false,
      },
    });

    await service.syncSubscription("shop-1", paidToken);

    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(subscriptionActivationService.finalizeInitialPaidActivation).toHaveBeenCalledWith(expect.objectContaining({
      transaction,
      expected: paidToken,
      existingSubscription: expect.objectContaining({ id: "subscription-1" }),
    }));
    expect(transaction.subscription.upsert).not.toHaveBeenCalled();
  });
});