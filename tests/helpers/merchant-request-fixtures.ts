import { vi } from "vitest";
import type { Shop, ShopSettings, Subscription } from "@prisma/client";
import type { authenticate } from "../../app/shopify.server";

export function merchantRows(domain = "merchant.myshopify.com") {
  const now = new Date("2026-11-04T00:00:00Z");
  const shop: Shop = {
    id: domain, domain, shopifyShopId: "gid://shopify/Shop/1", platform: "SHOPIFY",
    status: "ACTIVE", onboardingCompleted: true, storeLocale: "en",
    defaultLanguageTag: "en", defaultTimeZone: "UTC", defaultCountryCode: "GB",
    installedAt: now, uninstalledAt: null, reinstallPendingAt: null,
    createdAt: now, updatedAt: now,
  };
  const settings: ShopSettings = {
    id: `settings-${domain}`, shopId: shop.id, onboardingCompleted: true, plan: null,
    recoveryDelayMinutes: 30, aiResponseDelayMinutes: 0, recoveryOfferMode: "NONE",
    fixedShopifyDiscountId: null, followUpEnabled: false, followUpDelayMinutes: null,
    notifyOnInitialRecoveryOutreach: false, defaultLanguageTag: "en",
    defaultTimeZone: "UTC", defaultCountryCode: "GB", createdAt: now, updatedAt: now,
  };
  const subscription: Subscription = {
    id: `subscription-${domain}`, shopId: shop.id, status: "ACTIVE", planId: null,
    observedShopifyPlanHandle: null, billingPeriodId: null, currentPeriodStart: null,
    currentPeriodEnd: null, trialEndsAt: null, cancelAtPeriodEnd: false,
    providerSubscriptionId: null, providerCoverageEndAt: null, lastSyncedAt: null,
    lastSyncErrorCode: null, lastSyncErrorAt: null, pendingShopifyPlanHandle: null,
    pendingPlanId: null, pendingEffectiveAt: null, nextReconcileAt: null,
    lastProviderLifecycleState: null, lastProviderLifecycleEventId: null,
    lastProviderLifecycleEventAt: null, createdAt: now, updatedAt: now,
  };
  return {shop, settings, subscription};
}

// Synthetic SDK port. Router execution and service code remain real in their suites.
export function merchantFixture() {
  let rows = merchantRows();
  const graphql = vi.fn();
  const redirect = vi.fn();
  const authenticateAdmin = vi.fn(async () => ({
    session: {shop: rows.shop.domain, accessToken: "private-session-sentinel"},
    admin: {graphql}, redirect,
  }) as unknown as Awaited<ReturnType<typeof authenticate.admin>>);
  const snapshot = vi.fn(async () => rows);
  const lookup = vi.fn(async () => rows.shop as Shop | null);
  const readSubscription = vi.fn(async () => rows.subscription as Subscription | null);
  const readSettings = vi.fn(async () => rows.settings as ShopSettings | null);
  return {
    authenticateAdmin, snapshot, lookup, readSubscription, readSettings, graphql, redirect,
    get rows() {return rows;},
    set rows(value) {rows = value;},
    reset() {
      vi.clearAllMocks();
      rows = merchantRows();
      snapshot.mockImplementation(async () => rows);
      lookup.mockImplementation(async () => rows.shop);
      readSubscription.mockImplementation(async () => rows.subscription);
      readSettings.mockImplementation(async () => rows.settings);
      authenticateAdmin.mockImplementation(async () => ({
        session: {shop: rows.shop.domain, accessToken: "private-session-sentinel"},
        admin: {graphql}, redirect,
      }) as unknown as Awaited<ReturnType<typeof authenticate.admin>>);
    },
  };
}
