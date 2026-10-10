import {
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  EntitlementCounter,
  ShopStatus,
  SubscriptionProjectionStatus,
  type PrismaClient,
} from "@prisma/client";

import type {
  BillingPeriodPhase,
  BillingProvider,
  MerchantShopifySubscriptionState,
  ProviderUsageItem,
} from "./billing.types";
import {
  deriveBillingPeriodPhase,
  hasDurableBillingPeriod,
  hasMatchingBillingCycle,
  isSafeNonNegativeInteger,
} from "./billing-period-projection";
import type { BillingPlanResolutionService } from "./billing-plan-resolution.service";
import { resolveCurrentRecoveryCreditOffers } from "../merchant-pricing/merchant-pricing.server.js";

type MerchantPricingPlanReader = Pick<
  BillingPlanResolutionService,
  "readMerchantPricingPlan"
>;

const SHOPIFY_BILLING_PROVIDER = "SHOPIFY";

function nonBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireShopifyPurchaseSummaryEvidence<
  T extends {
    provider: string;
    shopifyEventHandleSnapshot: string | null;
    usageEventId: string | null;
    usageEvent: { shopifyReportState: string } | null;
  },
>(purchase: T): T & {
  provider: "SHOPIFY";
  shopifyEventHandleSnapshot: string;
  usageEventId: string;
  usageEvent: { shopifyReportState: string };
} {
  if (
    purchase.provider !== SHOPIFY_BILLING_PROVIDER ||
    !nonBlank(purchase.shopifyEventHandleSnapshot) ||
    !nonBlank(purchase.usageEventId) ||
    !purchase.usageEvent
  ) {
    throw new Error("Shopify recovery credit purchase evidence is invalid.");
  }
  return purchase as T & {
    provider: "SHOPIFY";
    shopifyEventHandleSnapshot: string;
    usageEventId: string;
    usageEvent: { shopifyReportState: string };
  };
}

export class MerchantBillingReadService {
  constructor(
    private readonly provider: BillingProvider,
    private readonly database: PrismaClient,
    private readonly planResolutionService: MerchantPricingPlanReader,
  ) {}

  async getMerchantBillingState(
    shopId: string,
    verifiedCommercialState?: MerchantShopifySubscriptionState,
  ) {
    const [shop, subscription, counter, usageTotal, purchasedCounter] = await Promise.all([
      this.database.shop.findUnique({ where: { id: shopId } }),
      this.database.subscription.findUnique({
        where: { shopId },
        include: {
          plan: true,
          pendingPlan: true,
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
      this.database.usageEvent.aggregate({
        where: { shopId, metric: "RECOVERY_CONVERSATION" },
        _sum: { quantity: true },
      }),
      this.database.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: {
            shopId,
            counter: EntitlementCounter.PURCHASED_RECOVERY_CREDITS,
          },
        },
      }),
    ]);

    let recoveryCreditOffers: import("./billing.types").RecoveryCreditOffer[] = [];
    let recoveryCreditOfferDiagnostics: Array<{ code: string; handle: string }> = [];
    let recoveryCreditOfferVerificationState: import("./billing.types").RecoveryCreditOfferVerificationState = "VERIFIED";
    let recoveryCreditPackPurchaseEligible = false;
    let unavailableReason: string | null = null;
    const hasExactOpenLocalCycle = Boolean(
      shop?.status === ShopStatus.ACTIVE &&
      subscription?.status !== undefined &&
      (subscription.status === SubscriptionProjectionStatus.ACTIVE || subscription.status === SubscriptionProjectionStatus.TRIALING) &&
      subscription?.plan?.active === true &&
      hasDurableBillingPeriod(subscription) &&
      subscription.billingPeriod?.status === BillingPeriodStatus.OPEN &&
      subscription.currentPeriodStart &&
      subscription.currentPeriodEnd &&
      subscription.currentPeriodStart.getTime() < subscription.currentPeriodEnd.getTime(),
    );
    const billingPeriodPhase: BillingPeriodPhase | null = subscription &&
      hasDurableBillingPeriod(subscription) &&
      subscription.billingPeriod?.status === BillingPeriodStatus.OPEN &&
      subscription.currentPeriodStart!.getTime() < subscription.currentPeriodEnd!.getTime()
      ? deriveBillingPeriodPhase(subscription.currentPeriodEnd)
      : null;
    if (
      shop?.shopifyShopId &&
      billingPeriodPhase !== null
    ) {
      try {
        let providerSubscription: {
          planHandle: string;
          status: "ACTIVE" | "TRIALING";
          usageItems: ProviderUsageItem[];
          currentPeriodStart: Date | null;
          currentPeriodEnd: Date | null;
        } | null = null;

        if (verifiedCommercialState !== undefined) {
          if (verifiedCommercialState.status === "ACTIVE_SUBSCRIPTION") {
            const start = verifiedCommercialState.subscription.currentPeriodStart
              ? new Date(verifiedCommercialState.subscription.currentPeriodStart)
              : null;
            const end = verifiedCommercialState.subscription.currentPeriodEnd
              ? new Date(verifiedCommercialState.subscription.currentPeriodEnd)
              : null;
            providerSubscription = {
              planHandle: verifiedCommercialState.subscription.planHandle,
              status: verifiedCommercialState.subscription.trialEndsAt &&
                new Date(verifiedCommercialState.subscription.trialEndsAt) > new Date()
                ? "TRIALING"
                : "ACTIVE",
              usageItems: verifiedCommercialState.subscription.usageItems,
              currentPeriodStart: start && !Number.isNaN(start.getTime()) ? start : null,
              currentPeriodEnd: end && !Number.isNaN(end.getTime()) ? end : null,
            };
          }
        } else {
          providerSubscription = await this.provider.getActiveSubscription({
            shopifyShopId: shop.shopifyShopId,
          });
        }

        if (providerSubscription) {
          const merchantPricingPlan = await this.planResolutionService.readMerchantPricingPlan(providerSubscription.planHandle);
          const resolved = resolveCurrentRecoveryCreditOffers({ providerSubscription, merchantPricingPlan });
          recoveryCreditOffers = resolved.offers;
          recoveryCreditOfferDiagnostics = resolved.diagnostics;
          recoveryCreditPackPurchaseEligible = recoveryCreditOffers.length > 0;
        }
        recoveryCreditPackPurchaseEligible = Boolean(
          recoveryCreditPackPurchaseEligible &&
          subscription &&
          hasExactOpenLocalCycle &&
          providerSubscription &&
          hasMatchingBillingCycle(subscription, providerSubscription) &&
          subscription?.billingPeriod?.status === BillingPeriodStatus.OPEN &&
          billingPeriodPhase === "ACTIVE",
        );
        if (!recoveryCreditPackPurchaseEligible) {
          unavailableReason = "Recovery credit offers are not currently available.";
        }
      } catch {
        recoveryCreditOffers = [];
        recoveryCreditOfferDiagnostics = [];
        recoveryCreditOfferVerificationState = "VERIFICATION_UNAVAILABLE";
        recoveryCreditPackPurchaseEligible = false;
        unavailableReason = "Shopify billing details could not be verified.";
      }
    }

    const [latestPurchase, unresolvedPurchases] = await Promise.all([
      this.database.recoveryCreditPurchase?.findFirst?.({
        where: { shopId, provider: SHOPIFY_BILLING_PROVIDER },
        orderBy: { createdAt: "desc" },
        include: { usageEvent: true },
      }) ?? Promise.resolve(null),
      this.database.recoveryCreditPurchase?.findMany?.({
        where: {
          shopId,
          provider: SHOPIFY_BILLING_PROVIDER,
          status: "REQUESTED",
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { usageEvent: true },
      }) ?? Promise.resolve([]),
    ]);
    const latestShopifyPurchase = latestPurchase
      ? requireShopifyPurchaseSummaryEvidence(latestPurchase)
      : null;
    const unresolvedShopifyPurchases = unresolvedPurchases.map(
      requireShopifyPurchaseSummaryEvidence,
    );

    const isPaid = subscription?.plan?.kind === BillingPlanKind.PAID_METERED;
    const periodCounter = subscription?.billingPeriod?.entitlementCounters.find(
      ({ counter }) => counter === BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
    ) ?? null;
    const paidPeriod = subscription?.billingPeriod;
    const includedGrant = paidPeriod?.includedRecoveryCreditsGranted;
    const hasValidPaidPeriod = Boolean(
      isPaid &&
      subscription?.status === SubscriptionProjectionStatus.ACTIVE &&
      subscription.plan?.active === true &&
      subscription.plan.kind === BillingPlanKind.PAID_METERED &&
      subscription.observedShopifyPlanHandle === subscription.plan.shopifyPlanHandle &&
      hasDurableBillingPeriod(subscription) &&
      paidPeriod?.id === subscription.billingPeriodId &&
      paidPeriod.shopId === shopId &&
      paidPeriod.subscriptionId === subscription.id &&
      paidPeriod.planId === subscription.plan.id &&
      paidPeriod.shopifyPlanHandleSnapshot === subscription.plan.shopifyPlanHandle &&
      paidPeriod.planKindSnapshot === BillingPlanKind.PAID_METERED &&
      paidPeriod.status === BillingPeriodStatus.OPEN &&
      paidPeriod.periodStart < paidPeriod.periodEnd &&
      isSafeNonNegativeInteger(includedGrant) &&
      periodCounter?.shopId === shopId &&
      periodCounter.billingPeriodId === paidPeriod.id &&
      periodCounter.grantedQuantity === includedGrant &&
      isSafeNonNegativeInteger(periodCounter.committedQuantity) &&
      isSafeNonNegativeInteger(periodCounter.reservedQuantity) &&
      isSafeNonNegativeInteger(periodCounter.forfeitedQuantity) &&
      periodCounter.currentAllowanceQuantity === null &&
      periodCounter.committedQuantity +
        periodCounter.reservedQuantity +
        periodCounter.forfeitedQuantity <= periodCounter.grantedQuantity,
    );
    const paidIncluded = hasValidPaidPeriod && periodCounter
      ? {
          grantedQuantity: periodCounter.grantedQuantity,
          committedQuantity: periodCounter.committedQuantity,
          reservedQuantity: periodCounter.reservedQuantity,
          forfeitedQuantity: periodCounter.forfeitedQuantity,
          remaining: Math.max(
            periodCounter.grantedQuantity -
              periodCounter.committedQuantity -
              periodCounter.reservedQuantity -
              periodCounter.forfeitedQuantity,
            0,
          ),
        }
      : null;
    const allowance = isPaid ? null : counter?.grantedQuantity ?? null;
    const committed = isPaid ? 0 : counter?.committedQuantity ?? 0;
    const reserved = isPaid ? 0 : counter?.reservedQuantity ?? 0;
    const remaining = isPaid
      ? null
      : allowance === null
        ? null
        : Math.max(allowance - committed - reserved, 0);

    return {
      subscription,
      allowance,
      committed,
      reserved,
      remaining,
      paidIncluded,
      paidConfigurationUnavailable: isPaid && !paidIncluded,
      lifetimeFree: {
        grantedQuantity: counter?.grantedQuantity ?? 0,
        committedQuantity: counter?.committedQuantity ?? 0,
        reservedQuantity: counter?.reservedQuantity ?? 0,
        remaining: Math.max(
          (counter?.grantedQuantity ?? 0) -
            (counter?.committedQuantity ?? 0) -
            (counter?.reservedQuantity ?? 0),
          0,
        ),
      },
      usageQuantity: Number(usageTotal._sum.quantity ?? 0),
      purchasedRecoveryCredits: {
        grantedQuantity: purchasedCounter?.grantedQuantity ?? 0,
        committedQuantity: purchasedCounter?.committedQuantity ?? 0,
        reservedQuantity: purchasedCounter?.reservedQuantity ?? 0,
        refundingQuantity: purchasedCounter?.refundingQuantity ?? 0,
        available: Math.max(
          (purchasedCounter?.grantedQuantity ?? 0)
            - (purchasedCounter?.committedQuantity ?? 0)
            - (purchasedCounter?.reservedQuantity ?? 0)
            - (purchasedCounter?.refundingQuantity ?? 0),
          0,
        ),
      },
      recoveryCreditOffers,
      recoveryCreditOfferDiagnostics,
      recoveryCreditOfferVerificationState,
      recoveryCreditPackMeterVerified: recoveryCreditOfferVerificationState === "VERIFIED",
      recoveryCreditPackPurchaseEligible,
      configured: recoveryCreditOffers.length > 0,
      purchaseEligible: recoveryCreditPackPurchaseEligible,
      unavailableReason,
      latestPurchase: latestShopifyPurchase
        ? {
            id: latestShopifyPurchase.id,
            status: latestShopifyPurchase.status,
            creditsGranted: latestShopifyPurchase.creditsGranted,
            currentAmount: latestShopifyPurchase.currentAmount,
            reservedAmount: latestShopifyPurchase.reservedAmount,
            eventHandle: latestShopifyPurchase.shopifyEventHandleSnapshot,
            label: recoveryCreditOffers.find(
              (offer) => offer.eventHandle === latestShopifyPurchase.shopifyEventHandleSnapshot,
            )?.label ?? latestShopifyPurchase.shopifyEventHandleSnapshot,
            createdAt: latestShopifyPurchase.createdAt.toISOString(),
            activatedAt: latestShopifyPurchase.activatedAt?.toISOString() ?? null,
            usageReportState: latestShopifyPurchase.usageEvent.shopifyReportState,
          }
        : null,
      unresolvedPurchases: unresolvedShopifyPurchases.map((purchase) => ({
        id: purchase.id,
        eventHandle: purchase.shopifyEventHandleSnapshot,
        creditsGranted: purchase.creditsGranted,
        createdAt: purchase.createdAt.toISOString(),
        usageReportState: purchase.usageEvent.shopifyReportState,
      })),
      billingPeriodPhase,
    };
  }
}