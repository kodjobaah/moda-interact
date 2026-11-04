import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { createPaidActivationFixture } from "./billing-activation";
import type { BillingProvider, ProviderSubscription } from "../../app/services/billing/billing.types";
import { BillingPlanResolutionService } from "../../app/services/billing/billing-plan-resolution.service";
import { RecoveryCreditPurchaseRequestService } from "../../app/services/billing/recovery-credit-purchase-request.service";

export function barrier(participants = 1) {
  let arrive!: () => void;
  let release!: () => void;
  let count = 0;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { arrived, release, async wait() { if (++count === participants) arrive(); await released; } };
}

// Observe or pause actual Prisma operations; all reads, writes and rollbacks remain real.
export function transactionPort(database: PrismaClient, hooks: {
  before?: () => Promise<void>;
  after?: (model: string, method: string) => Promise<void>;
  beforeMethod?: (model: string, method: string) => Promise<void>;
  open?: (value: boolean) => void;
} = {}): PrismaClient {
  return new Proxy(database, { get(target, property) {
    if (property === "$transaction") return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => {
      await hooks.before?.();
      return target.$transaction(async tx => {
        hooks.open?.(true);
        const observed = new Proxy(tx, { get(client, model) {
          const delegate = Reflect.get(client, model);
          if (typeof delegate !== "object" || delegate === null) return typeof delegate === "function" ? delegate.bind(client) : delegate;
          return new Proxy(delegate, { get(port, method) {
            const operation = Reflect.get(port, method);
            if (typeof operation !== "function") return operation;
            return async (...args: unknown[]) => {
              await hooks.beforeMethod?.(String(model), String(method));
              const result = await operation.apply(port, args);
              await hooks.after?.(String(model), String(method));
              return result;
            };
          } });
        } });
        try { return await callback(observed); } finally { hooks.open?.(false); }
      }, { ...options, timeout: 30_000 });
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export async function createPurchaseFixture(database: PrismaClient, label: string) {
  const base = await createPaidActivationFixture(database, label);
  const start = new Date(Date.now() - 86_400_000);
  const end = new Date(Date.now() + 29 * 86_400_000);
  const eventHandle = `${base.planHandle}-pack`;
  await database.merchantPricingUsageEvent.create({ data: {
    merchantPricingPlanId: base.merchantPricingPlanId, eventHandle, adminLabel: "Credit pack",
    creditsGrantedPerUnit: 10, position: 0, pricingMode: "FIXED", currency: "USD", fixedUnitAmountMinor: 500,
  } });
  const subscription = await database.subscription.create({ data: {
    shopId: base.shopId, planId: base.planId, status: "ACTIVE", currentPeriodStart: start, currentPeriodEnd: end,
  } });
  const period = await database.billingPeriod.create({ data: {
    shopId: base.shopId, subscriptionId: subscription.id, planId: base.planId,
    periodStart: start, periodEnd: end, status: "OPEN",
  } });
  await database.subscription.update({ where: { id: subscription.id }, data: { billingPeriodId: period.id } });
  const providerSubscription: ProviderSubscription = {
    provider: "SHOPIFY", planHandle: base.planHandle, billingPeriod: "EVERY_30_DAYS",
    currentFlatRatePlan: { handle: base.planHandle, description: null, price: { amount: "12.00", currency: "USD" } },
    pendingFlatRatePlan: null, usageItems: [{ handle: eventHandle, description: null,
      price: { kind: "TIERED", active: true, currency: "USD", tiersMode: "VOLUME", tiers: [] },
      usage: { quantity: 0, costAmount: "0.00", costCurrency: "USD" } }],
    usageEventHandles: [eventHandle, base.usageEventHandle], pendingPlanHandle: null, pendingEffectiveAt: null,
    status: "ACTIVE", currentPeriodStart: start, currentPeriodEnd: end, trialEndsAt: null,
    cancelAtPeriodEnd: false, providerSubscriptionId: `provider-${base.shopId}`, providerUsageSnapshot: [],
  };
  const lifecycle = vi.fn(async () => ({ activeSubscription: providerSubscription, latestLifecycleEvent: null }));
  const active = vi.fn(async () => providerSubscription);
  const provider = { getSubscriptionLifecycleSnapshot: lifecycle, getActiveSubscription: active } as unknown as BillingProvider;
  const catalogue = new BillingPlanResolutionService(database);
  const catalogueRead = vi.spyOn(catalogue, "readMerchantPricingPlan");
  return { ...base, period, subscription, eventHandle, providerSubscription, provider, lifecycle, active, catalogueRead,
    service: (port = database) => new RecoveryCreditPurchaseRequestService(provider, port, catalogue),
    request: (service: RecoveryCreditPurchaseRequestService, id: string = randomUUID()) =>
      service.requestRecoveryCreditPack(base.shopId, "BUY_RECOVERY_CREDIT_PACK", id, eventHandle),
  };
}
