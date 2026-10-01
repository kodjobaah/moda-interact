import {
  BillingPlanKind,
  SubscriptionProjectionStatus,
  type PrismaClient,
} from "@prisma/client";

import type {
  BillingProvider,
  MerchantShopifyLifecycleState,
  MerchantShopifySubscriptionState,
} from "./billing.types";

export class SubscriptionReadService {
  constructor(
    private readonly provider: BillingProvider,
    private readonly database: PrismaClient,
  ) {}

  async getSubscriptionProjection(shopId: string) {
    return this.database.subscription.findUnique({
      where: { shopId },
      include: { plan: true, pendingPlan: true, billingPeriod: true },
    });
  }

  async getSubscription(shopId: string) {
    const subscription = await this.database.subscription.findUnique({
      where: { shopId },
      include: { plan: true },
    });

    return subscription && (subscription.status === SubscriptionProjectionStatus.ACTIVE || subscription.status === SubscriptionProjectionStatus.TRIALING)
      ? subscription
      : null;
  }

  async getMerchantShopifySubscriptionState(
    shopId: string,
  ): Promise<MerchantShopifySubscriptionState> {
    const shop = await this.database.shop.findUnique({
      where: { id: shopId },
    });

    if (!shop) {
      throw new Error(`Shop ${shopId} was not found`);
    }
    if (!shop.shopifyShopId) {
      throw new Error(`Shop ${shopId} does not have a Shopify shop ID`);
    }

    const providerSubscription = await this.provider.getActiveSubscription({
      shopifyShopId: shop.shopifyShopId,
    });

    if (!providerSubscription) {
      return {
        status: "NO_ACTIVE_SUBSCRIPTION",
        subscription: null,
      };
    }

    return this.mapMerchantShopifySubscription(providerSubscription);
  }

  async getMerchantShopifyLifecycleState(
    shopId: string,
  ): Promise<MerchantShopifyLifecycleState> {
    const shop = await this.database.shop.findUnique({
      where: { id: shopId },
    });

    if (!shop) {
      throw new Error(`Shop ${shopId} was not found`);
    }
    if (!shop.shopifyShopId) {
      throw new Error(`Shop ${shopId} does not have a Shopify shop ID`);
    }
    if (!this.provider.getSubscriptionLifecycleSnapshot) {
      throw new Error("Shopify lifecycle snapshot is not supported by the billing provider");
    }

    const snapshot = await this.provider.getSubscriptionLifecycleSnapshot({
      shopifyShopId: shop.shopifyShopId,
    });
    const latestEvent = snapshot.latestLifecycleEvent;
    const activeState = snapshot.activeSubscription
      ? await this.mapMerchantShopifySubscription(snapshot.activeSubscription)
      : null;

    if (latestEvent?.state === "FROZEN") {
      const frozenPlan = latestEvent.planHandle
        ? await this.database.billingPlan.findUnique({
            where: { shopifyPlanHandle: latestEvent.planHandle },
            select: { id: true, name: true, kind: true },
          })
        : null;
      return {
        state: "FROZEN",
        subscription: activeState,
        latestEvent,
        providerPlanHandle: latestEvent.planHandle,
        billingPeriod: latestEvent.billingPeriod,
        modaMapping: frozenPlan
          ? {
              id: frozenPlan.id,
              name: frozenPlan.name,
              kind: frozenPlan.kind === BillingPlanKind.FREE ? "FREE" : "PAID_METERED",
            }
          : null,
        mappingStatus: frozenPlan ? "MAPPED" : "UNMAPPED",
      };
    }

    if (!snapshot.activeSubscription && latestEvent?.state === "CANCELED") {
      return { state: "CANCELED", subscription: null, latestEvent };
    }
    if (snapshot.activeSubscription) {
      return { state: "ACTIVE", subscription: activeState!, latestEvent };
    }
    if (latestEvent) {
      return { state: "UNRESOLVED", subscription: null, latestEvent };
    }
    return { state: "NO_ACTIVE_SUBSCRIPTION", subscription: null, latestEvent: null };
  }

  private async mapMerchantShopifySubscription(
    providerSubscription: NonNullable<Awaited<ReturnType<BillingProvider["getActiveSubscription"]>>>,
  ): Promise<MerchantShopifySubscriptionState & { status: "ACTIVE_SUBSCRIPTION" }> {
    const [currentPlan, pendingPlan] = await Promise.all([
      this.database.billingPlan.findUnique({
        where: { shopifyPlanHandle: providerSubscription.planHandle },
        select: { id: true, name: true, kind: true },
      }),
      providerSubscription.pendingFlatRatePlan
        ? this.database.billingPlan.findUnique({
            where: {
              shopifyPlanHandle: providerSubscription.pendingFlatRatePlan.handle,
            },
            select: { id: true, name: true, kind: true },
          })
        : null,
    ]);

    const mapping = currentPlan
      ? {
          id: currentPlan.id,
          name: currentPlan.name,
          kind: currentPlan.kind === BillingPlanKind.FREE ? "FREE" as const : "PAID_METERED" as const,
        }
      : null;
    const pendingMapping = pendingPlan
      ? {
          id: pendingPlan.id,
          name: pendingPlan.name,
          kind: pendingPlan.kind === BillingPlanKind.FREE ? "FREE" as const : "PAID_METERED" as const,
        }
      : null;

    return {
      status: "ACTIVE_SUBSCRIPTION",
      subscription: {
        planHandle: providerSubscription.currentFlatRatePlan.handle,
        description: providerSubscription.currentFlatRatePlan.description,
        price: providerSubscription.currentFlatRatePlan.price,
        billingPeriod: providerSubscription.billingPeriod,
        currentPeriodStart: providerSubscription.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: providerSubscription.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: providerSubscription.trialEndsAt?.toISOString() ?? null,
        cancelAtEndOfCycle: providerSubscription.cancelAtPeriodEnd,
        pendingUpdate: providerSubscription.pendingFlatRatePlan
          ? {
              planHandle: providerSubscription.pendingFlatRatePlan.handle,
              price: providerSubscription.pendingFlatRatePlan.price,
              effectiveAt: providerSubscription.pendingFlatRatePlan.effectiveAt?.toISOString() ?? null,
            }
          : null,
        usageItems: providerSubscription.usageItems,
      },
      modaMapping: mapping,
      mappingStatus: mapping ? "MAPPED" : "UNMAPPED",
      pendingModaMapping: pendingMapping,
    };
  }
}