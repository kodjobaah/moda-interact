import {
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  EntitlementCounter,
  PromotionCampaignStatus,
  PromotionTargetScope,
  ProviderSubscriptionLifecycleState,
  SubscriptionProjectionStatus,
  type PrismaClient,
} from "@prisma/client";

import type { MerchantRecoveryCapacityState } from "./billing.types";
import type { BillingPlanResolutionService } from "./billing-plan-resolution.service";

type TopUpConfigurationReader = Pick<
  BillingPlanResolutionService,
  "readRecoveryCreditTopUpConfiguration"
>;

export class MerchantRecoveryCapacityReadService {
  constructor(
    private readonly database: PrismaClient,
    private readonly planResolutionService: TopUpConfigurationReader,
  ) {}

  async getMerchantRecoveryCapacityState(
    shopId: string,
  ): Promise<MerchantRecoveryCapacityState> {
    const [subscription, lifetimeCounter, purchasedCounter, selection] = await Promise.all([
      this.database.subscription.findUnique({
        where: { shopId },
        include: {
          plan: true,
          shop: { select: { onboardingCompleted: true } },
          billingPeriod: {
            include: {
              entitlementCounters: {
                where: {
                  counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
                },
              },
            },
          },
        },
      }),
      this.database.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId,
            counter: EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS,
          },
        },
      }),
      this.database.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId,
            counter: EntitlementCounter.PURCHASED_RECOVERY_CREDITS,
          },
        },
      }),
      this.database.merchantPromotionSelection.findUnique({
        where: { shopId },
        include: {
          promotionalCreditGrant: {
            include: { campaign: true },
          },
        },
      }),
    ]);

    const freeLifetime = lifetimeCounter
      ? {
          granted: lifetimeCounter.grantedQuantity,
          committed: lifetimeCounter.committedQuantity,
          reserved: lifetimeCounter.reservedQuantity,
          remaining: Math.max(
            lifetimeCounter.grantedQuantity -
              lifetimeCounter.committedQuantity -
              lifetimeCounter.reservedQuantity,
            0,
          ),
        }
      : null;
    const purchased = {
      granted: purchasedCounter?.grantedQuantity ?? 0,
      committed: purchasedCounter?.committedQuantity ?? 0,
      reserved: purchasedCounter?.reservedQuantity ?? 0,
      refunding: purchasedCounter?.refundingQuantity ?? 0,
      available: Math.max(
        (purchasedCounter?.grantedQuantity ?? 0) -
          (purchasedCounter?.committedQuantity ?? 0) -
          (purchasedCounter?.reservedQuantity ?? 0) -
          (purchasedCounter?.refundingQuantity ?? 0),
        0,
      ),
    };
    const selectedGrant = selection?.promotionalCreditGrant;
    const campaign = selectedGrant?.campaign;
    const now = new Date();
    const promotionTargetMatches = campaign && (
      campaign.scope === PromotionTargetScope.GLOBAL ||
      (campaign.scope === PromotionTargetScope.PLAN && campaign.targetPlanId === subscription?.planId) ||
      (campaign.scope === PromotionTargetScope.SHOP && campaign.targetShopId === shopId)
    );
    const promotional = selectedGrant && campaign && promotionTargetMatches &&
      campaign.status === PromotionCampaignStatus.ACTIVE &&
      campaign.startsAt <= now && campaign.expiresAt > now
      && selectedGrant.quantity >= 0
      && selectedGrant.committedQuantity >= 0
      && selectedGrant.reservedQuantity >= 0
      && selectedGrant.committedQuantity + selectedGrant.reservedQuantity <= selectedGrant.quantity
      ? {
          granted: selectedGrant.quantity,
          committed: selectedGrant.committedQuantity,
          reserved: selectedGrant.reservedQuantity,
          remaining: Math.max(
            selectedGrant.quantity -
              selectedGrant.committedQuantity -
              selectedGrant.reservedQuantity,
            0,
          ),
        }
      : { granted: 0, committed: 0, reserved: 0, remaining: 0 };

    const reconciledPlanMapping = subscription?.plan && subscription.plan.active
      ? {
          id: subscription.plan.id,
          shopifyPlanHandle: subscription.plan.shopifyPlanHandle,
          name: subscription.plan.name,
          kind: subscription.plan.kind === BillingPlanKind.FREE ? "FREE" as const : "PAID_METERED" as const,
        }
      : null;
    const paidPeriod = subscription?.billingPeriod;
    const periodCounter = paidPeriod?.entitlementCounters.find(
      ({ counter }) => counter === BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
    );
    const paidIncluded = reconciledPlanMapping?.kind === "PAID_METERED" &&
      (subscription?.status === SubscriptionProjectionStatus.ACTIVE ||
        subscription?.status === SubscriptionProjectionStatus.TRIALING ||
        subscription?.status === SubscriptionProjectionStatus.FROZEN) &&
      paidPeriod &&
      periodCounter &&
      paidPeriod.status === BillingPeriodStatus.OPEN &&
      paidPeriod.shopId === shopId &&
      paidPeriod.subscriptionId === subscription.id &&
      paidPeriod.planId === subscription.planId &&
      subscription.billingPeriodId === paidPeriod.id &&
      subscription.observedShopifyPlanHandle === subscription.plan?.shopifyPlanHandle &&
      paidPeriod.shopifyPlanHandleSnapshot === subscription.plan?.shopifyPlanHandle &&
      paidPeriod.planKindSnapshot === BillingPlanKind.PAID_METERED &&
      subscription.currentPeriodStart &&
      subscription.currentPeriodEnd &&
      paidPeriod.periodStart.getTime() === subscription.currentPeriodStart.getTime() &&
      paidPeriod.periodEnd.getTime() === subscription.currentPeriodEnd.getTime() &&
      paidPeriod.periodStart < paidPeriod.periodEnd &&
      periodCounter.shopId === shopId &&
      periodCounter.billingPeriodId === paidPeriod.id &&
      periodCounter.grantedQuantity >= 0 &&
      periodCounter.committedQuantity >= 0 &&
      periodCounter.reservedQuantity >= 0 &&
      periodCounter.forfeitedQuantity >= 0 &&
      periodCounter.currentAllowanceQuantity === null &&
      periodCounter.committedQuantity + periodCounter.reservedQuantity + periodCounter.forfeitedQuantity <= periodCounter.grantedQuantity
      ? {
          billingPeriodId: paidPeriod.id,
          periodStart: paidPeriod.periodStart.toISOString(),
          periodEnd: paidPeriod.periodEnd.toISOString(),
          granted: periodCounter.grantedQuantity,
          committed: periodCounter.committedQuantity,
          reserved: periodCounter.reservedQuantity,
          forfeited: periodCounter.forfeitedQuantity,
          remaining: Math.max(
            periodCounter.grantedQuantity -
              periodCounter.committedQuantity -
              periodCounter.reservedQuantity -
              periodCounter.forfeitedQuantity,
            0,
          ),
        }
      : null;

    const postContract = Boolean(
      subscription?.status === SubscriptionProjectionStatus.NO_CONTRACT &&
      subscription.lastProviderLifecycleState === ProviderSubscriptionLifecycleState.CANCELED &&
      subscription.shop?.onboardingCompleted === true,
    );
    const spendablePromotional = postContract
      ? { granted: 0, committed: 0, reserved: 0, remaining: 0 }
      : promotional;
    const topUpConfiguration = !subscription || subscription.status === SubscriptionProjectionStatus.NO_CONTRACT
      ? { enabled: false, creditsPerPack: null }
      : await this.planResolutionService.readRecoveryCreditTopUpConfiguration(
          subscription.plan?.shopifyPlanHandle ?? subscription.observedShopifyPlanHandle,
        );

    const base = {
      reconciledPlanMapping,
      observedShopifyPlanHandle: subscription?.observedShopifyPlanHandle ?? null,
      freeLifetime,
      paidIncluded,
      promotional: spendablePromotional,
      purchased,
      topUpConfiguration,
    };
    if (!subscription) {
      return { ...base, availability: "CONTRACT_REQUIRED", capacitySource: null, canStartRecovery: false };
    }
    if (subscription.status === SubscriptionProjectionStatus.NO_CONTRACT) {
      if (!postContract) {
        return { ...base, availability: "CONTRACT_REQUIRED", capacitySource: null, canStartRecovery: false };
      }
      const capacitySource = purchased.available > 0
        ? "PURCHASED" as const
        : freeLifetime?.remaining && freeLifetime.remaining > 0
          ? "FREE_LIFETIME" as const
          : null;
      return {
        ...base,
        availability: capacitySource ? "POST_CONTRACT_AVAILABLE" : "POST_CONTRACT_EXHAUSTED",
        capacitySource: capacitySource ?? "EXHAUSTED",
        canStartRecovery: Boolean(capacitySource),
      };
    }
    if (subscription.status === SubscriptionProjectionStatus.FROZEN) {
      return { ...base, availability: "CONTRACT_FROZEN", capacitySource: null, canStartRecovery: false };
    }
    if (
      (subscription.status !== SubscriptionProjectionStatus.ACTIVE && subscription.status !== SubscriptionProjectionStatus.TRIALING) ||
      !reconciledPlanMapping ||
      subscription.observedShopifyPlanHandle !== subscription.plan?.shopifyPlanHandle ||
      (reconciledPlanMapping.kind === "PAID_METERED" && !paidIncluded)
    ) {
      return { ...base, availability: "CONFIGURATION_UNAVAILABLE", capacitySource: null, canStartRecovery: false };
    }

    if (spendablePromotional.remaining <= 0 &&
      !(reconciledPlanMapping.kind === "PAID_METERED" && paidIncluded!.remaining > 0) &&
      purchased.available <= 0 &&
      !freeLifetime) {
      return { ...base, availability: "CONFIGURATION_UNAVAILABLE", capacitySource: null, canStartRecovery: false };
    }

    const capacitySource = spendablePromotional.remaining > 0
      ? "PROMOTIONAL"
      : reconciledPlanMapping.kind === "PAID_METERED" && paidIncluded!.remaining > 0
        ? "PAID_INCLUDED"
        : purchased.available > 0
          ? "PURCHASED"
          : freeLifetime?.remaining && freeLifetime.remaining > 0
            ? "FREE_LIFETIME"
            : null;
    return {
      ...base,
      availability: capacitySource ? "AVAILABLE" : "EXHAUSTED",
      capacitySource: capacitySource ?? "EXHAUSTED",
      canStartRecovery: Boolean(capacitySource),
    };
  }
}