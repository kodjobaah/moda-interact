import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import type {
  BillingProvider,
  ProviderSubscription,
} from "../../../../app/services/billing/billing.types";
import { SubscriptionReadService } from "../../../../app/services/billing/subscription-read.service";

function providerSubscription(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    provider: "SHOPIFY",
    planHandle: "growth",
    billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: {
      handle: "growth",
      description: "Growth",
      price: { amount: "19.00", currency: "USD" },
    },
    pendingFlatRatePlan: null,
    usageItems: [],
    usageEventHandles: [],
    pendingPlanHandle: null,
    pendingEffectiveAt: null,
    status: "ACTIVE",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-1",
    providerUsageSnapshot: [],
    ...overrides,
  };
}

function createService(options: {
  subscription?: Record<string, unknown> | null;
  shop?: Record<string, unknown> | null;
  planRows?: Array<Record<string, unknown> | null>;
  provider?: BillingProvider;
} = {}) {
  const findSubscription = vi.fn().mockResolvedValue(options.subscription ?? null);
  const findShop = vi.fn().mockResolvedValue(options.shop ?? {
    id: "shop-1",
    shopifyShopId: "gid://shopify/Shop/1",
  });
  const planRows = [...(options.planRows ?? [])];
  const findPlan = vi.fn().mockImplementation(async () => planRows.shift() ?? null);
  const database = {
    subscription: { findUnique: findSubscription },
    shop: { findUnique: findShop },
    billingPlan: { findUnique: findPlan },
  };
  const provider = options.provider ?? {
    getActiveSubscription: vi.fn().mockResolvedValue(null),
    getSubscriptionLifecycleSnapshot: vi.fn().mockResolvedValue({
      activeSubscription: null,
      latestLifecycleEvent: null,
    }),
  };
  return {
    service: new SubscriptionReadService(provider, database as unknown as PrismaClient),
    database,
    provider,
  };
}

describe("SubscriptionReadService", () => {
  it("returns only active or trialing local subscriptions and keeps the projection include graph", async () => {
    const active = { id: "active", status: "ACTIVE" };
    const { service, database } = createService({ subscription: active });

    await expect(service.getSubscription("shop-1")).resolves.toBe(active);
    expect(database.subscription.findUnique).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      include: { plan: true },
    });

    const noContract = createService({ subscription: { id: "none", status: "NO_CONTRACT" } });
    await expect(noContract.service.getSubscription("shop-1")).resolves.toBeNull();

    await service.getSubscriptionProjection("shop-1");
    expect(database.subscription.findUnique).toHaveBeenLastCalledWith({
      where: { shopId: "shop-1" },
      include: { plan: true, pendingPlan: true, billingPeriod: true },
    });
  });

  it("maps current and pending Shopify plans independently", async () => {
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue(providerSubscription({
        pendingFlatRatePlan: {
          handle: "starter",
          price: { amount: "0.00", currency: "USD" },
          effectiveAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      })),
    };
    const { service, database } = createService({
      provider,
      planRows: [
        { id: "growth-id", name: "Growth", kind: "PAID_METERED" },
        { id: "starter-id", name: "Starter", kind: "FREE" },
      ],
    });

    await expect(service.getMerchantShopifySubscriptionState("shop-1")).resolves.toMatchObject({
      status: "ACTIVE_SUBSCRIPTION",
      subscription: {
        planHandle: "growth",
        currentPeriodStart: "2026-09-01T00:00:00.000Z",
        pendingUpdate: { planHandle: "starter", effectiveAt: "2026-10-01T00:00:00.000Z" },
      },
      modaMapping: { id: "growth-id", kind: "PAID_METERED" },
      pendingModaMapping: { id: "starter-id", kind: "FREE" },
      mappingStatus: "MAPPED",
    });
    expect(provider.getActiveSubscription).toHaveBeenCalledTimes(1);
    expect(database.billingPlan.findUnique).toHaveBeenCalledTimes(2);
  });

  it("gives frozen lifecycle evidence precedence over an active subscription", async () => {
    const event = {
      id: "event-1",
      eventType: "SUBSCRIPTION_FROZEN" as const,
      state: "FROZEN" as const,
      occurredAt: new Date("2026-09-15T00:00:00.000Z"),
      cancelEffectiveOn: null,
      planHandle: "growth",
      billingPeriod: "EVERY_30_DAYS",
    };
    const provider = {
      getActiveSubscription: vi.fn(),
      getSubscriptionLifecycleSnapshot: vi.fn().mockResolvedValue({
        activeSubscription: providerSubscription(),
        latestLifecycleEvent: event,
      }),
    };
    const { service, database } = createService({
      provider,
      planRows: [
        { id: "growth-id", name: "Growth", kind: "PAID_METERED" },
        { id: "growth-frozen-id", name: "Growth frozen", kind: "PAID_METERED" },
      ],
    });

    await expect(service.getMerchantShopifyLifecycleState("shop-1")).resolves.toMatchObject({
      state: "FROZEN",
      subscription: { status: "ACTIVE_SUBSCRIPTION" },
      latestEvent: event,
      modaMapping: { id: "growth-frozen-id" },
    });
    expect(provider.getSubscriptionLifecycleSnapshot).toHaveBeenCalledTimes(1);
    expect(provider.getActiveSubscription).not.toHaveBeenCalled();
    expect(database.subscription.findUnique).not.toHaveBeenCalled();
  });

  it("propagates provider failures without falling back to local subscription state", async () => {
    const provider = {
      getActiveSubscription: vi.fn(),
      getSubscriptionLifecycleSnapshot: vi.fn().mockRejectedValue(new Error("Partner unavailable")),
    };
    const { service, database } = createService({
      provider,
      subscription: { id: "local-active", status: "ACTIVE" },
    });

    await expect(service.getMerchantShopifyLifecycleState("shop-1"))
      .rejects.toThrow("Partner unavailable");
    expect(provider.getActiveSubscription).not.toHaveBeenCalled();
    expect(database.subscription.findUnique).not.toHaveBeenCalled();
  });
});