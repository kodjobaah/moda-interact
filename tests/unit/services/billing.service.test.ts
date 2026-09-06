import { describe, expect, it, vi } from "vitest";

import {
  BillingService,
  renderSubscriptionEndedMessage,
} from "../../../app/services/billing/billing.service";

type State = {
  languageTag: string;
  active: boolean;
  subscription: {
    planHandle: string;
    provider: string;
    providerSubscriptionId: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    trialEndsAt: Date | null;
  };
  existingMessage: boolean;
  existingTranslation: boolean;
  failSupport: boolean;
  sourceKeys: string[];
  supportWrites: number;
  translationLookupMisses?: boolean;
  translationInsertConflict?: boolean;
  translationInsertAttempts?: number;
};

function createDatabase(state: State) {
  const database = {
    shop: {
      findUnique: vi.fn().mockResolvedValue({ id: "shop-1", shopifyShopId: "gid://shop/1" }),
    },
    subscription: {
      findFirst: vi.fn().mockImplementation(async () => state.active
        ? { id: "subscription-row-1", ...state.subscription }
        : null),
      findUnique: vi.fn().mockResolvedValue({
        id: "subscription-row-1", status: "CANCELLED", ...state.subscription,
      }),
      updateMany: vi.fn().mockImplementation(async () => {
        if (!state.active) return { count: 0 };
        state.active = false;
        return { count: 1 };
      }),
      upsert: vi.fn().mockResolvedValue({ id: "subscription-row-1" }),
      update: vi.fn(),
      create: vi.fn(),
    },
    billingPlan: {
      findUnique: vi.fn().mockResolvedValue({ id: "plan-1", handle: "growth", active: true }),
    },
    $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
      if (callback.toString().includes("subscription.findFirst")) {
        return callback({ subscription: database.subscription });
      }
      if (state.failSupport) {
        state.failSupport = false;
        throw new Error("support database unavailable");
      }
      const transaction = {
        subscription: database.subscription,
        $queryRaw: vi.fn().mockImplementation(async (query: { sql: string; values: unknown[] }) => {
          const sourceKey = query.values.find((value): value is string =>
            typeof value === "string" && value.startsWith("subscription-ended%3Av1:"),
          );
          if (sourceKey && !state.sourceKeys.includes(sourceKey)) state.sourceKeys.push(sourceKey);
          if (query.sql.includes('"ShopSettings"')) return [{ defaultLanguageTag: state.languageTag }];
          if (query.sql.includes('"MerchantSupportMessage"') && query.sql.includes('"sourceKey"')) {
            if (query.sql.includes("INSERT INTO")) {
              if (state.existingMessage) return [];
              state.existingMessage = true;
              state.supportWrites += 1;
              return [{ id: "message-new" }];
            }
            return state.existingMessage ? [{ id: "message-existing" }] : [];
          }
          if (query.sql.includes('"MerchantSupportThread"') && query.sql.includes('RETURNING')) return [{ id: "thread-1" }];
          if (query.sql.includes('"MerchantMessageTranslation"')) {
            if (query.sql.includes("INSERT INTO")) {
              state.translationInsertAttempts = (state.translationInsertAttempts ?? 0) + 1;
              if (state.translationInsertConflict) return [];
              if (state.existingTranslation) return [];
              state.existingTranslation = true;
              state.supportWrites += 1;
              return [{ id: "translation-new" }];
            }
            if (state.translationLookupMisses) return [];
            return state.existingTranslation ? [{ id: "translation-existing" }] : [];
          }
          return [];
        }),
        $executeRaw: vi.fn().mockImplementation(async (query: { sql: string; values: unknown[] }) => {
          state.supportWrites += 1;
          return 1;
        }),
      };
      return callback(transaction);
    }),
  };
  return database;
}

function inactiveProvider() {
  return { getActiveSubscription: vi.fn().mockResolvedValue(null) };
}

describe("BillingService subscription-ended notification", () => {
  it("renders factual source copy from the plan handle", () => {
    expect(renderSubscriptionEndedMessage("growth")).toBe(
      "Your growth subscription has ended and is no longer active.",
    );
  });

  it("keeps cancellation committed when support persistence fails, then repairs it", async () => {
    const state: State = {
      languageTag: "en-GB", active: true,
      subscription: { planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: "provider-1", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null },
      existingMessage: false, existingTranslation: false, failSupport: true,
      sourceKeys: [], supportWrites: 0,
    };
    const database = createDatabase(state);
    const service = new BillingService(inactiveProvider(), database as never, vi.fn());

    await expect(service.syncSubscription("shop-1")).resolves.toBeNull();
    expect(state.active).toBe(false);
    expect(state.existingMessage).toBe(false);
    await service.syncSubscription("shop-1");
    await service.syncSubscription("shop-1");
    expect(state.existingMessage).toBe(true);
    expect(state.sourceKeys).toEqual([
      "subscription-ended%3Av1:shop-1:SHOPIFY:provider%3Aprovider-1",
    ]);
  });

  it("uses one deterministic message per later provider lifecycle", async () => {
    const state: State = {
      languageTag: "en-GB", active: true,
      subscription: { planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: "provider-1", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null },
      existingMessage: false, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
    };
    const database = createDatabase(state);
    const service = new BillingService(inactiveProvider(), database as never, vi.fn());

    await service.syncSubscription("shop-1");
    state.active = true;
    state.subscription.providerSubscriptionId = "provider-2";
    state.existingMessage = false;
    await service.syncSubscription("shop-1");

    expect(state.sourceKeys).toEqual([
      "subscription-ended%3Av1:shop-1:SHOPIFY:provider%3Aprovider-1",
      "subscription-ended%3Av1:shop-1:SHOPIFY:provider%3Aprovider-2",
    ]);
    expect(state.sourceKeys[0]).toContain("shop-1:SHOPIFY:");
    expect(state.sourceKeys[1]).toContain("shop-1:SHOPIFY:");
  });

  it("reuses the unique subscription row when a cancelled shop reactivates", async () => {
    const state: State = {
      languageTag: "en-GB", active: false,
      subscription: { planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: "provider-1", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null },
      existingMessage: true, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
    };
    const database = createDatabase(state);
    const provider = {
      getActiveSubscription: vi.fn().mockResolvedValue({
        planHandle: "growth", provider: "SHOPIFY", status: "ACTIVE", providerSubscriptionId: "provider-2",
      }),
    };
    await new BillingService(provider, database as never, vi.fn()).syncSubscription("shop-1");

    expect(database.subscription.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "subscription-row-1" } }));
    expect(database.subscription.create).not.toHaveBeenCalled();
  });

  it("keeps English available without translation dispatch", async () => {
    const state: State = {
      languageTag: "en-US", active: true,
      subscription: { planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: "provider-1", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null },
      existingMessage: false, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
    };
    const dispatch = vi.fn();
    await new BillingService(inactiveProvider(), createDatabase(state) as never, dispatch).syncSubscription("shop-1");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("creates one pending non-English translation and dispatches after commit", async () => {
    const state: State = {
      languageTag: "fr-FR", active: true,
      subscription: { planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: "provider-1", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null },
      existingMessage: false, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
    };
    const database = createDatabase(state);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    await new BillingService(inactiveProvider(), database as never, dispatch).syncSubscription("shop-1");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("translation-new");
    expect(state.supportWrites).toBe(3);
  });

  it("isolates translation dispatch failure after durable support state", async () => {
    const state: State = {
      languageTag: "fr-FR", active: true,
      subscription: { planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: "provider-1", currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null },
      existingMessage: false, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
    };
    const database = createDatabase(state);
    const dispatch = vi.fn().mockRejectedValue(new Error("Redis unavailable"));
    await expect(new BillingService(inactiveProvider(), database as never, dispatch).syncSubscription("shop-1")).resolves.toBeNull();
    expect(state.active).toBe(false);
    expect(state.existingMessage).toBe(true);
    expect(state.existingTranslation).toBe(true);
  });

  it("uses stable cycle facts when the provider subscription ID is nullable", async () => {
    const state: State = {
      languageTag: "en-GB", active: true,
      subscription: {
        planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: null,
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), trialEndsAt: null,
      },
      existingMessage: false, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
    };
    await new BillingService(inactiveProvider(), createDatabase(state) as never, vi.fn()).syncSubscription("shop-1");
    expect(state.existingMessage).toBe(true);
    expect(state.sourceKeys[0]).toContain("cycle%3Agrowth%3A2026-09-01T00%3A00%3A00.000Z");
  });

  it("creates a distinct fallback key for a later cycle on the same shop", async () => {
    const state: State = {
      languageTag: "en-GB", active: true,
      subscription: {
        planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: null,
        currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"), trialEndsAt: null,
      },
      existingMessage: false, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
    };
    const database = createDatabase(state);
    const service = new BillingService(inactiveProvider(), database as never, vi.fn());
    await service.syncSubscription("shop-1");
    state.active = true;
    state.existingMessage = false;
    state.subscription.currentPeriodStart = new Date("2026-10-01T00:00:00.000Z");
    state.subscription.currentPeriodEnd = new Date("2026-11-01T00:00:00.000Z");
    await service.syncSubscription("shop-1");
    expect(state.sourceKeys).toHaveLength(2);
    expect(state.sourceKeys[0]).not.toBe(state.sourceKeys[1]);
  });

  it("does not dispatch when the translation insert loses a concurrent unique-key race", async () => {
    const state: State = {
      languageTag: "fr-FR", active: false,
      subscription: {
        planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: "provider-1",
        currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null,
      },
      existingMessage: true, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
      translationLookupMisses: true,
      translationInsertConflict: true,
    };
    const dispatch = vi.fn();
    const database = createDatabase(state);
    await new BillingService(inactiveProvider(), database as never, dispatch).syncSubscription("shop-1");
    expect(state.translationInsertAttempts).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails explicitly when no durable lifecycle identity exists", async () => {
    const state: State = {
      languageTag: "en-GB", active: true,
      subscription: {
        planHandle: "growth", provider: "SHOPIFY", providerSubscriptionId: null,
        currentPeriodStart: null, currentPeriodEnd: null, trialEndsAt: null,
      },
      existingMessage: false, existingTranslation: false, failSupport: false,
      sourceKeys: [], supportWrites: 0,
    };
    await expect(
      new BillingService(inactiveProvider(), createDatabase(state) as never, vi.fn()).syncSubscription("shop-1"),
    ).rejects.toThrow("Unable to derive a durable subscription lifecycle identity.");
    expect(state.active).toBe(false);
  });
});
