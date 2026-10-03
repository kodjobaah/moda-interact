import { describe, expect, it, vi } from "vitest";

import {
  BillingService,
  renderSubscriptionEndedMessage,
} from "../../../../app/services/billing/billing.service";
import {
  deriveLifecycleIdentity,
  MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY,
  SubscriptionEndedNotificationService,
  type SubscriptionIdentityFacts,
} from "../../../../app/services/billing/subscription-ended-notification.service";

function makeDatabase(results: unknown[]) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const queryRaw = vi.fn(async (query: { sql: string; values: unknown[] }) => {
    queries.push({ sql: query.sql, values: query.values });
    return results.shift() ?? [];
  });
  const executeRaw = vi.fn().mockResolvedValue(1);
  let committed = false;
  const transaction = { $queryRaw: queryRaw, $executeRaw: executeRaw };
  const database = {
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
      const result = await callback(transaction);
      committed = true;
      return result;
    }),
  };

  return {
    database,
    queryRaw,
    queries,
    executeRaw,
    hasCommitted: () => committed,
  };
}

function makeEndedSyncDatabase(current: Record<string, unknown>, notificationQueryRaw: () => Promise<unknown>) {
  let projectionCommitted = false;
  let transactionCount = 0;
  const subscription = {
    findUnique: vi.fn().mockResolvedValue(current),
    upsert: vi.fn().mockResolvedValue({}),
  };
  const projectionTransaction = {
    subscription,
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const notificationTransaction = {
    $queryRaw: vi.fn(async () => {
      expect(projectionCommitted).toBe(true);
      return notificationQueryRaw();
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const database = {
    shop: {
      findUnique: vi.fn().mockResolvedValue({
        id: "shop-1",
        status: "ACTIVE",
        shopifyShopId: "gid://shop/1",
      }),
    },
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
      transactionCount += 1;
      if (transactionCount === 1) {
        const result = await callback(projectionTransaction);
        projectionCommitted = true;
        return result;
      }
      return callback(notificationTransaction);
    }),
  };

  return { database, subscription, hasProjectionCommitted: () => projectionCommitted };
}

const lifecycleFacts: SubscriptionIdentityFacts = {
  observedShopifyPlanHandle: "growth",
  providerSubscriptionId: " provider/123 ",
  currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
  trialEndsAt: null,
};

describe("SubscriptionEndedNotificationService", () => {
  it("derives identity from provider ID first, then lifecycle cycle facts", () => {
    expect(deriveLifecycleIdentity(lifecycleFacts)).toBe("provider:provider/123");
    expect(deriveLifecycleIdentity({
      ...lifecycleFacts,
      providerSubscriptionId: null,
    })).toBe("cycle:growth:2026-01-01T00:00:00.000Z:2026-02-01T00:00:00.000Z:none");
    expect(deriveLifecycleIdentity({
      ...lifecycleFacts,
      providerSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
    })).toBeNull();
  });

  it("preserves the subscription-ended message compatibility export", () => {
    expect(renderSubscriptionEndedMessage("growth")).toBe(
      "Your growth subscription has ended and is no longer active.",
    );
  });

  it("persists source-keyed messages with configured language and dispatches only after commit", async () => {
    const state = makeDatabase([
      [{ defaultLanguageTag: "fr-FR" }],
      [],
      [{ id: "thread-1" }],
      [{ id: "message-1" }],
      [],
      [{ id: "translation-1" }],
    ]);
    const dispatch = vi.fn(async () => {
      expect(state.hasCommitted()).toBe(true);
    });
    const service = new SubscriptionEndedNotificationService(state.database as never, dispatch);

    await service.notifySubscriptionEnded("shop/1", {
      planHandle: "growth",
      provider: "SHOPIFY",
      lifecycleIdentity: "provider:g/1",
    });

    const sourceKey = "subscription-ended%3Av1:shop%2F1:SHOPIFY:provider%3Ag%2F1";
    const insertedMessageValues = state.queries[3].values;
    const insertedTranslationValues = state.queries[5].values;
    expect(insertedMessageValues).toContain(sourceKey);
    expect(insertedMessageValues).toContain("PROCESSING");
    expect(insertedMessageValues).toContain("fr-FR");
    expect(insertedMessageValues).toContain("BILLING_SUBSCRIPTION_ENDED");
    expect(state.queries[0]?.sql).toContain('FROM "commerce"."Shop"');
    expect(insertedTranslationValues).toContain("fr-FR");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("translation-1");
  });

  it("reuses the existing message language and translation without duplicate dispatch", async () => {
    const state = makeDatabase([
      [{ defaultLanguageTag: "en-US" }],
      [{ id: "message-existing", displayLanguageTag: "fr-FR" }],
      [{ id: "thread-1" }],
      [{ id: "translation-existing" }],
    ]);
    const dispatch = vi.fn();
    const service = new SubscriptionEndedNotificationService(state.database as never, dispatch);

    await service.notifySubscriptionEnded("shop-1", {
      planHandle: "growth",
      provider: "SHOPIFY",
      lifecycleIdentity: "provider:sub-1",
    });

    expect(state.queryRaw).toHaveBeenCalledTimes(4);
    expect(state.queries[1].values).toContain(
      "subscription-ended%3Av1:shop-1:SHOPIFY:provider%3Asub-1",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rethrows missing durable lifecycle identity", async () => {
    const state = makeDatabase([[{ defaultLanguageTag: "en-US" }]]);
    const service = new SubscriptionEndedNotificationService(state.database as never, vi.fn());

    await expect(service.notifySubscriptionEnded("shop-1", {
      planHandle: "growth",
      provider: "SHOPIFY",
      lifecycleIdentity: null,
    })).rejects.toThrow(MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY);
  });

  it("keeps a committed billing projection when notification persistence fails", async () => {
    const state = makeEndedSyncDatabase({
      status: "ACTIVE",
      observedShopifyPlanHandle: "growth",
      providerSubscriptionId: "provider-1",
      currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
      trialEndsAt: null,
      pendingShopifyPlanHandle: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
      nextReconcileAt: null,
      planId: "plan-1",
    }, async () => {
      throw new Error("support database unavailable");
    });
    const service = new BillingService(
      { getActiveSubscription: vi.fn().mockResolvedValue(null) },
      state.database as never,
    );

    await expect(service.syncSubscription("shop-1")).resolves.toBeNull();

    expect(state.hasProjectionCommitted()).toBe(true);
    expect(state.subscription.upsert).toHaveBeenCalledOnce();
  });

  it("propagates missing lifecycle identity only after the billing projection commits", async () => {
    const state = makeEndedSyncDatabase({
      status: "ACTIVE",
      observedShopifyPlanHandle: null,
      providerSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: null,
      pendingShopifyPlanHandle: null,
      pendingPlanId: null,
      pendingEffectiveAt: null,
      nextReconcileAt: null,
      planId: "plan-1",
    }, async () => [{ defaultLanguageTag: "en-US" }]);
    const service = new BillingService(
      { getActiveSubscription: vi.fn().mockResolvedValue(null) },
      state.database as never,
    );

    await expect(service.syncSubscription("shop-1"))
      .rejects.toThrow(MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY);

    expect(state.hasProjectionCommitted()).toBe(true);
    expect(state.subscription.upsert).toHaveBeenCalledOnce();
  });

  it("keeps other persistence and translation failures best-effort", async () => {
    const failedPersistence = new SubscriptionEndedNotificationService({
      $transaction: vi.fn().mockRejectedValue(new Error("support database unavailable")),
    } as never, vi.fn());
    await expect(failedPersistence.notifySubscriptionEnded("shop-1", {
      planHandle: "growth",
      provider: "SHOPIFY",
      lifecycleIdentity: "provider:sub-1",
    })).resolves.toBeUndefined();

    const state = makeDatabase([
      [{ defaultLanguageTag: "fr-FR" }],
      [],
      [{ id: "thread-1" }],
      [{ id: "message-1" }],
      [],
      [{ id: "translation-1" }],
    ]);
    const failedDispatch = new SubscriptionEndedNotificationService(
      state.database as never,
      vi.fn().mockRejectedValue(new Error("queue unavailable")),
    );
    await expect(failedDispatch.notifySubscriptionEnded("shop-1", {
      planHandle: "growth",
      provider: "SHOPIFY",
      lifecycleIdentity: "provider:sub-1",
    })).resolves.toBeUndefined();
    expect(state.hasCommitted()).toBe(true);
  });
});