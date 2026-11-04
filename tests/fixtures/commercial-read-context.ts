import { vi } from "vitest";
import type { PrismaClient, Shop, Subscription, BillingPlan } from "@prisma/client";
import type { BillingProvider, MerchantShopifySubscriptionState, ProviderSubscription } from "../../app/services/billing/billing.types";

export const commercialNow = new Date("2026-09-15T12:00:00Z");
export function commercialReadFixture() {
  const shop = { id: "shop-1", domain: "merchant.myshopify.com", platform: "SHOPIFY", status: "ACTIVE",
    shopifyShopId: "gid://shopify/Shop/1", onboardingCompleted: true } as Shop;
  const plan = { id: "plan-1", name: "Current plan", kind: "PAID_METERED", active: true,
    shopifyPlanHandle: "growth", shopifyUsageEventHandle: "message-meter" } as BillingPlan;
  const pendingPlan = { ...plan, id: "plan-2", name: "Pending plan", shopifyPlanHandle: "scale" };
  const start = new Date("2026-09-01T00:00:00Z");
  const end = new Date("2026-10-01T00:00:00Z");
  const subscription = { id: "subscription-1", shopId: shop.id, status: "ACTIVE", planId: plan.id,
    pendingPlanId: pendingPlan.id, pendingEffectiveAt: end, observedShopifyPlanHandle: "growth", billingPeriodId: "period-1",
    currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false } as Subscription;
  const period = { id: "period-1", shopId: shop.id, subscriptionId: subscription.id, planId: plan.id,
    shopifyPlanHandleSnapshot: plan.shopifyPlanHandle, planKindSnapshot: "PAID_METERED", status: "OPEN", periodStart: start,
    periodEnd: end, includedRecoveryCreditsGranted: 30, entitlementCounters: [{
      shopId: shop.id, billingPeriodId: "period-1", counter: "INCLUDED_RECOVERY_CREDITS", grantedQuantity: 30,
      committedQuantity: 5, reservedQuantity: 3, forfeitedQuantity: 2, currentAllowanceQuantity: null,
    }] };
  const counters = [
    { shopId: shop.id, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 10, committedQuantity: 4, reservedQuantity: 1 },
    { shopId: shop.id, counter: "PURCHASED_RECOVERY_CREDITS", grantedQuantity: 20, committedQuantity: 4, reservedQuantity: 2, refundingQuantity: 3 },
  ];
  const pricingPlan = { id: "quote-1", shopifyPlanHandle: "growth", planKind: "PAID_METERED", recurringAmountMinor: 1000,
    currency: "USD", billingPeriod: "EVERY_30_DAYS", usageEvents: [{ id: "meter-1", eventHandle: "pack", adminLabel: "Credit pack",
      creditsGrantedPerUnit: 10, position: 0, pricingMode: "FIXED", currency: "USD", fixedUnitAmountMinor: 500, tiers: [] }] };
  const live: ProviderSubscription = {
    provider: "SHOPIFY", planHandle: "growth", billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: { handle: "growth", description: "Growth", price: { amount: "10.00", currency: "USD" } },
    pendingFlatRatePlan: null, usageItems: [{ handle: "pack", description: "Credit pack", price: {
      kind: "TIERED", active: true, currency: "USD", tiersMode: "VOLUME", tiers: [{ upTo: null, amountPerUnit: "5.00", amount: "0.00" }],
    }, usage: { quantity: 0, costAmount: "0.00", costCurrency: "USD" } }],
    usageEventHandles: ["message-meter", "pack"], status: "ACTIVE", currentPeriodStart: start, currentPeriodEnd: end,
    pendingPlanHandle: null, pendingEffectiveAt: null, trialEndsAt: null, cancelAtPeriodEnd: false,
    providerSubscriptionId: "provider-1", providerUsageSnapshot: [],
  };
  const database = {
    shop: { findUnique: vi.fn(async () => shop) },
    subscription: { findUnique: vi.fn(async () => ({ ...subscription, plan, pendingPlan, billingPeriod: period, shop })) },
    billingPlan: { findMany: vi.fn(async () => [plan, pendingPlan]), findUnique: vi.fn(async () => plan) },
    billingPeriod: { findFirst: vi.fn(async () => period) },
    shopEntitlementCounter: { findMany: vi.fn(async () => counters), findUnique: vi.fn(async (query: { where: { shopId_counter: { counter: string } } }) =>
      counters.find(row => row.counter === query.where.shopId_counter.counter) ?? null) },
    merchantPromotionSelection: { findUnique: vi.fn(async () => null) },
    merchantPricingPlan: { findMany: vi.fn(async () => [pricingPlan]), findUnique: vi.fn(async () => pricingPlan) },
    recoveryCreditPurchase: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    usageEvent: { aggregate: vi.fn(async () => ({ _sum: { quantity: 123 } })) },
    platformConfiguration: { findUnique: vi.fn(async () => ({ fixture: true })) },
    $transaction: vi.fn(),
  };
  // Controlled provider port: its credential read is observable separately from
  // the request and local domain reads. No real Partner request is executed.
  const provider = { getActiveSubscription: vi.fn(async () => {
    await database.platformConfiguration.findUnique(); return live;
  }) };
  const calls = () => database.billingPlan.findMany.mock.calls.length + database.billingPeriod.findFirst.mock.calls.length +
    database.shopEntitlementCounter.findMany.mock.calls.length + database.merchantPromotionSelection.findUnique.mock.calls.length +
    database.merchantPricingPlan.findMany.mock.calls.length + database.recoveryCreditPurchase.findFirst.mock.calls.length +
    database.recoveryCreditPurchase.findMany.mock.calls.length + database.platformConfiguration.findUnique.mock.calls.length;
  return { shop, subscription, plan, pendingPlan, period, counters, pricingPlan, live, database, provider, calls,
    input: { shop, subscription, now: commercialNow } };
}

// Existing domain regression fixtures predate scalar request contexts. These
// adapters prepare their facts for the pure projectors only; production page
// orchestration is exercised separately through the real new service/facade.
export async function projectBillingFixture(database: PrismaClient, provider: BillingProvider,
  pricing: { readMerchantPricingPlan: (handle: string) => Promise<unknown> }, shopId: string,
  commercial?: MerchantShopifySubscriptionState) {
  const { projectMerchantBillingState } = await import("../../app/services/billing/merchant-billing-read.service");
  const { hasDurableBillingPeriod } = await import("../../app/services/billing/billing-period-projection");
  const [shop, subscription, lifetimeCounter, purchasedCounter] = await Promise.all([
    database.shop.findUnique({ where: { id: shopId } }),
    database.subscription.findUnique({ where: { shopId }, include: { plan: true, pendingPlan: true,
      billingPeriod: { include: { entitlementCounters: true } } } }),
    database.shopEntitlementCounter.findUnique({ where: { shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } } }),
    database.shopEntitlementCounter.findUnique({ where: { shopId_counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" } } }),
  ]);
  let observed: ProviderSubscription | null = null;
  let merchantPricingPlan: unknown = null;
  let verificationUnavailable = false;
  if (shop?.shopifyShopId && subscription && hasDurableBillingPeriod(subscription) && subscription.billingPeriod?.status === "OPEN" && subscription.billingPeriod.periodStart < subscription.billingPeriod.periodEnd) {
    try {
      observed = commercial !== undefined ? commercial.status === "ACTIVE_SUBSCRIPTION" ? {
        ...commercial.subscription, status: commercial.subscription.trialEndsAt && new Date(commercial.subscription.trialEndsAt) > new Date() ? "TRIALING" : "ACTIVE", currentPeriodStart: commercial.subscription.currentPeriodStart ? new Date(commercial.subscription.currentPeriodStart) : null,
        currentPeriodEnd: commercial.subscription.currentPeriodEnd ? new Date(commercial.subscription.currentPeriodEnd) : null,
      } as unknown as ProviderSubscription : null : await provider.getActiveSubscription({ shopifyShopId: shop.shopifyShopId });
      if (observed) merchantPricingPlan = await pricing.readMerchantPricingPlan(observed.planHandle);
    } catch { verificationUnavailable = true; }
  }
  return projectMerchantBillingState({ shop, subscription, lifetimeCounter, purchasedCounter, now: new Date(),
    providerSubscription: observed, merchantPricingPlan, verificationUnavailable,
    latestPurchase: await database.recoveryCreditPurchase?.findFirst?.({ where: { shopId, provider: "SHOPIFY" } }) ?? null,
    unresolvedPurchases: await database.recoveryCreditPurchase?.findMany?.({ where: { shopId, provider: "SHOPIFY", status: "REQUESTED" } }) ?? [],
  } as never);
}
export async function projectCapacityFixture(database: PrismaClient, pricing: {
  readRecoveryCreditTopUpConfiguration: (handle: string | null | undefined) => Promise<unknown>;
}, shopId: string) {
  const { projectMerchantRecoveryCapacity } = await import("../../app/services/billing/merchant-recovery-capacity-read.service");
  const subscription = await database.subscription.findUnique({ where: { shopId }, include: { plan: true, shop: { select: { onboardingCompleted: true } },
    billingPeriod: { include: { entitlementCounters: { where: { counter: "INCLUDED_RECOVERY_CREDITS" } } } } } });
  return projectMerchantRecoveryCapacity({ shop: { id: shopId, onboardingCompleted: subscription?.shop?.onboardingCompleted }, subscription,
    lifetimeCounter: await database.shopEntitlementCounter.findUnique({ where: { shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" } } }),
    purchasedCounter: await database.shopEntitlementCounter.findUnique({ where: { shopId_counter: { shopId, counter: "PURCHASED_RECOVERY_CREDITS" } } }),
    selection: await database.merchantPromotionSelection.findUnique({ where: { shopId }, include: { promotionalCreditGrant: { include: { campaign: true } } } }), now: new Date(),
    topUpConfiguration: !subscription || subscription.status === "NO_CONTRACT" ? { enabled: false, creditsPerPack: null } :
      await pricing.readRecoveryCreditTopUpConfiguration(subscription.plan?.shopifyPlanHandle ?? subscription.observedShopifyPlanHandle),
  } as never);
}
