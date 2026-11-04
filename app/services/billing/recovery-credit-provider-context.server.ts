import type { BillingPeriod, RecoveryCreditPurchase, Shop, Subscription } from "@prisma/client";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";

import type { BillingProvider, ProviderSubscription } from "./billing.types";

export type RecoveryCreditProviderObservation = Readonly<{
  shopifyShopId: string;
  subscription: ProviderSubscription | null;
}>;

export type ShopifyPurchaseEvidence = Pick<
  RecoveryCreditPurchase,
  "shopId" | "provider" | "billingPeriodId" | "shopifyPlanHandleSnapshot" |
  "shopifyEventHandleSnapshot" | "providerSubscriptionIdSnapshot"
>;

export type RecoveryCreditLocalContext = {
  shop: Pick<Shop, "id" | "platform" | "status" | "shopifyShopId"> | null;
  subscription: (Pick<Subscription, "shopId" | "billingPeriodId"> & {
    billingPeriod: Pick<BillingPeriod, "id" | "periodStart" | "periodEnd"> | null;
  }) | null;
};

export async function readRecoveryCreditProviderObservation(
  provider: BillingProvider,
  shopifyShopId: string,
): Promise<RecoveryCreditProviderObservation> {
  return {
    shopifyShopId,
    subscription: await provider.getActiveSubscription({ shopifyShopId }),
  };
}

export function matchesRecoveryCreditProviderContext(
  purchase: ShopifyPurchaseEvidence,
  local: RecoveryCreditLocalContext,
  observed: RecoveryCreditProviderObservation,
): boolean {
  const { shop, subscription } = local;
  const provider = observed.subscription;
  if (
    purchase.provider !== "SHOPIFY" ||
    !shop || shop.id !== purchase.shopId || shop.platform !== "SHOPIFY" || shop.status !== "ACTIVE" ||
    !shop.shopifyShopId || shop.shopifyShopId !== observed.shopifyShopId ||
    !subscription || subscription.shopId !== shop.id ||
    !provider || (provider.status !== "ACTIVE" && provider.status !== "TRIALING")
  ) return false;
  const identity = deriveShopifyProviderContextIdentity({
    providerSubscriptionId: provider.providerSubscriptionId,
    planHandle: provider.planHandle,
    currentPeriodStart: provider.currentPeriodStart,
    currentPeriodEnd: provider.currentPeriodEnd,
  });
  return (
    purchase.providerSubscriptionIdSnapshot === identity &&
    purchase.shopifyPlanHandleSnapshot === provider.planHandle &&
    purchase.billingPeriodId === subscription.billingPeriodId &&
    subscription.billingPeriod?.id === purchase.billingPeriodId &&
    subscription.billingPeriod?.periodStart.getTime() === provider.currentPeriodStart?.getTime() &&
    subscription.billingPeriod?.periodEnd.getTime() === provider.currentPeriodEnd?.getTime() &&
    provider.usageEventHandles.includes(purchase.shopifyEventHandleSnapshot ?? "")
  );
}
