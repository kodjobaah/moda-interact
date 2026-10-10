import { randomUUID } from "node:crypto";

import {
  BillingPeriodStatus,
  BillingPlanKind,
  Prisma,
  ShopPlatform,
  ShopStatus,
  SubscriptionProjectionStatus,
  type PrismaClient,
} from "@prisma/client";
import {
  createShopifyUsageIdempotencyKey,
  deriveShopifyProviderContextIdentity,
} from "@modainteract/moda-interact-shared/billing";

import type {
  BillingProvider,
  ProviderSubscription,
  ProviderSubscriptionLifecycleSnapshot,
} from "./billing.types";
import { BillingPlanResolutionService } from "./billing-plan-resolution.service";
import { ShopifyBillingOperationService } from "./shopify-billing-operation.service";
import {
  deriveBillingPeriodPhase,
  hasDurableBillingPeriod,
  hasMatchingBillingCycle,
} from "./billing-period-projection";

const RECOVERY_CREDIT_PACK_UNAVAILABLE_DURING_TRANSITION =
  "Recovery credit packs are temporarily unavailable while the current Shopify billing cycle is being confirmed.";
const RECOVERY_CREDIT_PURCHASE_INTENT = "BUY_RECOVERY_CREDIT_PACK";
const SHOPIFY_BILLING_PROVIDER = "SHOPIFY";

function isSafeNonNegativeNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasUsageEventId<T extends object>(event: T): event is T & { id: string } {
  return "id" in event && typeof event.id === "string" && event.id.trim().length > 0;
}

function assertPurchaseId(purchaseId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(purchaseId)) {
    throw new Error("A valid recovery credit purchase ID is required.");
  }
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002",
  );
}

function hasProviderBeforeEvidence(
  usage: { quantity: number | null; costAmount: string | null; costCurrency: string | null } | null | undefined,
): usage is { quantity: number; costAmount: string; costCurrency: string } {
  return Boolean(
    usage &&
    isSafeNonNegativeNumber(usage.quantity) &&
    typeof usage.costAmount === "string" &&
    usage.costAmount.trim() &&
    typeof usage.costCurrency === "string" &&
    /^[A-Z]{3}$/.test(usage.costCurrency),
  );
}

function executableProviderSubscription(
  snapshot: ProviderSubscriptionLifecycleSnapshot,
): ProviderSubscription | null {
  if (snapshot.latestLifecycleEvent?.state === "FROZEN") return null;
  return snapshot.activeSubscription ?? null;
}

function sameRecoveryCreditProviderEvidence(
  left: ProviderSubscription,
  right: ProviderSubscription,
  eventHandle: string,
): boolean {
  const comparable = (subscription: ProviderSubscription) => ({
    planHandle: subscription.planHandle,
    status: subscription.status,
    providerSubscriptionId: subscription.providerSubscriptionId,
    currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    usageEventHandles: [...subscription.usageEventHandles].sort(),
    usageItem: subscription.usageItems.find((item) => item.handle === eventHandle) ?? null,
  });

  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function unresolvedPurchaseMessage(): string {
  return "A recovery credit pack is already awaiting Shopify confirmation.";
}

export class RecoveryCreditPurchaseRequestService {
  constructor(
    private readonly provider: BillingProvider,
    private readonly database: PrismaClient,
    private readonly planResolutionService: BillingPlanResolutionService,
    private readonly billingOperationService: ShopifyBillingOperationService =
      new ShopifyBillingOperationService(database),
  ) {}

  async requestRecoveryCreditPack(shopId: string, intent: string, purchaseId: string, eventHandle: string) {
    if (intent !== RECOVERY_CREDIT_PURCHASE_INTENT) {
      throw new Error("Unsupported billing action.");
    }
    assertPurchaseId(purchaseId);
    if (typeof eventHandle !== "string" || !eventHandle.trim() || eventHandle.length > 128) {
      throw new Error("A valid recovery credit offer is required.");
    }

    const existingPurchase = await this.database.recoveryCreditPurchase.findUnique({
      where: { id: purchaseId },
      include: { usageEvent: true },
    });
    if (existingPurchase) {
      if (
        existingPurchase.shopId !== shopId ||
        existingPurchase.provider !== SHOPIFY_BILLING_PROVIDER
      ) {
        throw new Error("Recovery credit purchase belongs to another shop or billing provider.");
      }
      return existingPurchase;
    }

    const [shop, subscription] = await Promise.all([
      this.database.shop.findUnique({ where: { id: shopId } }),
      this.database.subscription.findUnique({
        where: { shopId },
        include: { plan: true, billingPeriod: true },
      }),
    ]);
    if (
      shop?.platform !== ShopPlatform.SHOPIFY ||
      shop.status !== ShopStatus.ACTIVE ||
      !shop.shopifyShopId ||
      !subscription?.plan ||
      (subscription.status !== SubscriptionProjectionStatus.ACTIVE &&
        subscription.status !== SubscriptionProjectionStatus.TRIALING)
    ) {
      throw new Error("Recovery credit packs are unavailable for this subscription.");
    }

    const plan = subscription.plan;
    if (!plan.active) {
      throw new Error("Recovery credit packs are unavailable for this plan.");
    }
    if (!hasDurableBillingPeriod(subscription)) {
      throw new Error("The current local billing cycle could not be verified.");
    }
    const verifiedBillingPeriodId = subscription.billingPeriodId;
    if (!verifiedBillingPeriodId) {
      throw new Error("The current local billing cycle could not be verified.");
    }
    if (
      !subscription.billingPeriod ||
      subscription.billingPeriod.id !== verifiedBillingPeriodId ||
      subscription.billingPeriod.status !== BillingPeriodStatus.OPEN
    ) {
      throw new Error("The current local billing cycle could not be verified.");
    }
    if (!this.provider.getSubscriptionLifecycleSnapshot) {
      throw new Error("Shopify lifecycle snapshot is not supported by the billing provider");
    }
    const lifecycleSnapshot = await this.provider.getSubscriptionLifecycleSnapshot({ shopifyShopId: shop.shopifyShopId });
    let providerSubscription = executableProviderSubscription(lifecycleSnapshot);
    if (!providerSubscription && lifecycleSnapshot.latestLifecycleEvent?.state === "FROZEN") {
      throw new Error("The Shopify subscription is frozen.");
    }
    if (!providerSubscription || providerSubscription.planHandle !== plan.shopifyPlanHandle) {
      throw new Error("The recovery credit pack meter could not be verified with Shopify.");
    }
    const merchantPricingPlan = await this.planResolutionService.readMerchantPricingPlan(providerSubscription.planHandle);
    const selectedEvent = merchantPricingPlan?.usageEvents.find((event) => event.eventHandle === eventHandle);
    let providerPackMeter = providerSubscription.usageItems.find((item) => item.handle === eventHandle);
    if (!merchantPricingPlan || !selectedEvent || !providerPackMeter || !providerSubscription.usageEventHandles.includes(eventHandle)) {
      throw new Error("The selected recovery credit offer could not be verified with Shopify.");
    }
    const creditsGranted = selectedEvent.creditsGrantedPerUnit;
    const initialProviderBeforeEvidence = providerPackMeter.usage;
    if (!hasProviderBeforeEvidence(initialProviderBeforeEvidence)) {
      throw new Error("Shopify recovery credit usage before evidence is unavailable.");
    }
    if (!hasMatchingBillingCycle(subscription, providerSubscription, verifiedBillingPeriodId)) {
      throw new Error("The current Shopify billing cycle could not be verified.");
    }
    if (deriveBillingPeriodPhase(providerSubscription.currentPeriodEnd) !== "ACTIVE") {
      throw new Error(RECOVERY_CREDIT_PACK_UNAVAILABLE_DURING_TRANSITION);
    }
    const revalidatedLifecycleSnapshot = await this.provider.getSubscriptionLifecycleSnapshot({ shopifyShopId: shop.shopifyShopId });
    const revalidatedProviderSubscription = executableProviderSubscription(revalidatedLifecycleSnapshot);
    if (
      !revalidatedProviderSubscription ||
      !sameRecoveryCreditProviderEvidence(providerSubscription, revalidatedProviderSubscription, eventHandle)
    ) {
      throw new Error("Recovery credit pack provider configuration changed during purchase request.");
    }
    providerSubscription = revalidatedProviderSubscription;
    providerPackMeter = providerSubscription.usageItems.find((item) => item.handle === eventHandle);
    if (!providerPackMeter || !hasProviderBeforeEvidence(providerPackMeter.usage)) {
      throw new Error("Shopify recovery credit usage before evidence is unavailable.");
    }
    const providerBeforeEvidence = providerPackMeter.usage;
    const providerContextIdentity = deriveShopifyProviderContextIdentity({
      providerSubscriptionId: providerSubscription.providerSubscriptionId,
      planHandle: providerSubscription.planHandle,
      currentPeriodStart: providerSubscription.currentPeriodStart,
      currentPeriodEnd: providerSubscription.currentPeriodEnd,
    });
    const currentMerchantPricingPlan = await this.planResolutionService.readMerchantPricingPlan(providerSubscription.planHandle);
    const currentSelectedEvent = currentMerchantPricingPlan?.usageEvents.find((event) => event.eventHandle === eventHandle);
    if (
      !currentSelectedEvent ||
      currentSelectedEvent.creditsGrantedPerUnit !== creditsGranted ||
      !hasUsageEventId(currentSelectedEvent)
    ) {
      throw new Error("Recovery credit pack configuration changed during purchase request.");
    }

    try {
      return await this.database.$transaction(async (transaction) => {
      if ("$queryRaw" in transaction && typeof transaction.$queryRaw === "function") {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "billing"."Subscription"
          WHERE "shopId" = ${shopId}
          FOR UPDATE
        `);
      }
      const existing = await transaction.recoveryCreditPurchase.findUnique({
        where: { id: purchaseId },
        include: { usageEvent: true },
      });
      if (existing) {
        if (
          existing.shopId !== shopId ||
          existing.provider !== SHOPIFY_BILLING_PROVIDER
        ) {
          throw new Error("Recovery credit purchase belongs to another shop or billing provider.");
        }
        return existing;
      }

      const unresolved = await transaction.recoveryCreditPurchase.findFirst?.({
        where: {
          shopId,
          provider: SHOPIFY_BILLING_PROVIDER,
          status: "REQUESTED",
          shopifyEventHandleSnapshot: eventHandle,
        },
        orderBy: { createdAt: "asc" },
      });
      if (unresolved) throw new Error(unresolvedPurchaseMessage());

      const currentSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        include: { plan: true, billingPeriod: true },
      });
      const currentPlan = currentSubscription?.plan;
      if (
        !currentSubscription ||
        !currentPlan ||
        (currentSubscription.status !== SubscriptionProjectionStatus.ACTIVE && currentSubscription.status !== SubscriptionProjectionStatus.TRIALING) ||
        !currentPlan.active ||
        !currentSubscription.billingPeriod ||
        currentSubscription.billingPeriod.id !== currentSubscription.billingPeriodId ||
        currentSubscription.billingPeriod.status !== BillingPeriodStatus.OPEN ||
        !hasMatchingBillingCycle(currentSubscription, providerSubscription, verifiedBillingPeriodId) ||
        deriveBillingPeriodPhase(providerSubscription.currentPeriodEnd) !== "ACTIVE" ||
        currentPlan.shopifyPlanHandle !== providerSubscription.planHandle ||
        currentSelectedEvent?.creditsGrantedPerUnit !== creditsGranted ||
        (currentPlan.kind === BillingPlanKind.PAID_METERED &&
          (!currentPlan.shopifyUsageEventHandle ||
            currentPlan.shopifyUsageEventHandle === eventHandle ||
            !providerSubscription.usageEventHandles.includes(currentPlan.shopifyUsageEventHandle)))
      ) {
        throw new Error("Recovery credit pack configuration changed during purchase request.");
      }

      const usageEventId = randomUUID();
      const idempotencyKey = `recovery-credit-pack:${shopId}:${purchaseId}`;
      const usageEvent = await transaction.usageEvent.create({
        data: {
          id: usageEventId,
          shopId,
          billingPeriodId: currentSubscription.billingPeriodId as string,
          metric: "RECOVERY_CREDIT_PACK_PURCHASE",
          quantity: 1,
          idempotencyKey,
          sourceType: "RECOVERY_CREDIT_PURCHASE",
          sourceId: purchaseId,
          provider: SHOPIFY_BILLING_PROVIDER,
          shopifyReportState: "PENDING",
          shopifyEventHandle: eventHandle,
          shopifyIdempotencyKey: createShopifyUsageIdempotencyKey(shopId, usageEventId),
        },
      });
      const purchase = await transaction.recoveryCreditPurchase.create({
        data: {
          id: purchaseId,
          shopId,
          planId: currentPlan.id,
          provider: SHOPIFY_BILLING_PROVIDER,
          billingPeriodId: currentSubscription.billingPeriodId as string,
          shopifyPlanHandleSnapshot: currentPlan.shopifyPlanHandle,
          shopifyEventHandleSnapshot: eventHandle,
          providerSubscriptionIdSnapshot: providerContextIdentity,
          providerUsageQuantityBeforeSnapshot: providerBeforeEvidence.quantity,
          providerUsageCostBeforeSnapshot: providerBeforeEvidence.costAmount,
          providerUsageCostCurrencyBeforeSnapshot: providerBeforeEvidence.costCurrency,
          providerPriceSnapshot: providerPackMeter.price,
          creditsGranted,
          currentAmount: 0,
          reservedAmount: 0,
          status: "REQUESTED",
          usageEventId: usageEvent.id,
        },
        include: { usageEvent: true },
      });
      await this.billingOperationService.recordOneTimeChargeIntent(transaction, {
        shopId,
        purchaseId: purchase.id,
        usageEvent: currentSelectedEvent,
        providerQuantityBefore: providerBeforeEvidence.quantity,
        providerReference: usageEvent.shopifyIdempotencyKey!,
      });
      return purchase;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        const replay = await this.database.recoveryCreditPurchase.findUnique({
          where: { id: purchaseId },
          include: { usageEvent: true },
        });
        if (replay) {
          if (
            replay.shopId !== shopId ||
            replay.provider !== SHOPIFY_BILLING_PROVIDER
          ) {
            throw new Error("Recovery credit purchase belongs to another shop or billing provider.");
          }
          return replay;
        }
      }
      throw error;
    }
  }
}