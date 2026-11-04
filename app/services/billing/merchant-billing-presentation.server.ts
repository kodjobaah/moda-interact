import { EntitlementCounter, type PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../db.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import { deriveRecoveryCreditTopUpConfiguration } from "../merchant-pricing/merchant-pricing.server.js";
import { BillingPlanResolutionService } from "./billing-plan-resolution.service";
import { projectMerchantBillingState } from "./merchant-billing-read.service";
import { projectMerchantRecoveryCapacity } from "./merchant-recovery-capacity-read.service";
import { projectMerchantShopifySubscription } from "./subscription-read.service";
import { logBillingBoundaryFailure } from "./providers/shopify-billing-diagnostics.server";
import type { BillingProvider, MerchantBillingReadInput, MerchantHomeSubscriptionSummary, MerchantHomeBillingReadInput, MerchantBillingPresentation, MerchantHomeBillingPresentation } from "./billing.types";

const logger = createLogger({ serviceName: "moda-interact", environment: resolveDeploymentEnvironmentName() });
type Read<T> = { ok: true; value: T } | { ok: false; value: null };


/** Request-local presentation only; never mutation authority or an atomic snapshot. */
export class MerchantBillingPresentationReadService {
  private readonly pricing: BillingPlanResolutionService;
  constructor(private readonly provider: BillingProvider, private readonly database: PrismaClient = prisma,
    private readonly diagnostics: StructuredLogger = logger) {
    this.pricing = new BillingPlanResolutionService(database);
  }

  private async read<T>(input: MerchantBillingReadInput, stage: string, run: () => Promise<T>): Promise<Read<T>> {
    try { return { ok: true, value: await run() }; }
    catch (error) {
      logBillingBoundaryFailure({ event: "shopify.billing.presentation_failed", operation: "read_commercial_presentation",
        stage, shopId: input.shop.id, error }, this.diagnostics);
      return { ok: false, value: null };
    }
  }

  private async local(input: MerchantHomeBillingReadInput, providerHandles: readonly string[] = []) {
    const { shop, subscription } = input;
    const plans = await this.read(input, "read_plans", () => this.database.billingPlan.findMany({
      where: { OR: [{ id: { in: [...new Set([subscription?.planId, subscription?.pendingPlanId].filter((id): id is string => Boolean(id)))] } },
        { shopifyPlanHandle: { in: [...new Set(providerHandles)] } }] },
    }));
    const plan = plans.value?.find(row => row.id === subscription?.planId) ?? null;
    const pendingPlan = plans.value?.find(row => row.id === subscription?.pendingPlanId) ?? null;
    const localHandle = plan?.shopifyPlanHandle ?? subscription?.observedShopifyPlanHandle;
    const knownPricing = input.pricingCatalogue?.find(row => row.shopifyPlanHandle === localHandle);
    const [period, counters, selection, pricing] = await Promise.all([
      this.read(input, "read_period", () => subscription?.billingPeriodId ? this.database.billingPeriod.findFirst({
        where: { id: subscription.billingPeriodId, shopId: shop.id, subscriptionId: subscription.id },
        include: { entitlementCounters: { where: { counter: "INCLUDED_RECOVERY_CREDITS" } } },
      }) : Promise.resolve(null)),
      this.read(input, "read_counters", () => this.database.shopEntitlementCounter.findMany({
        where: { shopId: shop.id, counter: { in: [EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS, EntitlementCounter.PURCHASED_RECOVERY_CREDITS] } },
      })),
      this.read(input, "read_selected_promotion", () => this.database.merchantPromotionSelection.findUnique({
        where: { shopId: shop.id }, include: { promotionalCreditGrant: { include: { campaign: true } } },
      })),
      knownPricing || (!providerHandles.length && (!subscription || subscription.status === "NO_CONTRACT"))
        ? Promise.resolve({ ok: true as const, value: [] })
        : this.read(input, "read_pricing", () => this.pricing.readMerchantPricingPlansForPresentation(
          [...new Set([localHandle, ...providerHandles.slice(0, 1)].filter((handle): handle is string => Boolean(handle)))],
        )),
    ]);
    const validated = await this.read(input, "validate_related_rows", async () => {
      if (subscription && subscription.shopId !== shop.id) throw new Error("Commercial Subscription tenant mismatch.");
      if (period.value && (period.value.id !== subscription?.billingPeriodId || period.value.shopId !== shop.id ||
        period.value.subscriptionId !== subscription.id || period.value.planId !== subscription.planId)) throw new Error("Commercial billing period identity mismatch.");
      if (counters.value?.some(row => row.shopId !== shop.id)) throw new Error("Commercial balance tenant mismatch.");
      if (selection.value && (selection.value.shopId !== shop.id || selection.value.promotionalCreditGrant.shopId !== shop.id))
        throw new Error("Commercial promotion tenant mismatch.");
      return true;
    });
    return {
      plans, plan, pendingPlan, period, counters, selection, pricing,
      subscription: subscription ? { ...subscription, plan, pendingPlan, billingPeriod: period.value } : null,
      lifetimeCounter: counters.value?.find(row => row.counter === EntitlementCounter.LIFETIME_FREE_RECOVERY_CREDITS) ?? null,
      purchasedCounter: counters.value?.find(row => row.counter === EntitlementCounter.PURCHASED_RECOVERY_CREDITS) ?? null,
      topUpConfiguration: !subscription || subscription.status === "NO_CONTRACT" ? { enabled: false, creditsPerPack: null } : deriveRecoveryCreditTopUpConfiguration([...(knownPricing?.usageEvents ?? pricing.value?.find(row => row.shopifyPlanHandle === localHandle)?.usageEvents ?? [])]),
      valid: plans.ok && period.ok && counters.ok && selection.ok && pricing.ok && validated.ok,
    };
  }

  async readOptions(input: MerchantBillingReadInput): Promise<MerchantBillingPresentation> {
    const observed = await this.read(input, "read_provider", async () => {
      if (!input.shop.shopifyShopId) throw new Error("Shopify shop identity is unavailable.");
      return this.provider.getActiveSubscription({ shopifyShopId: input.shop.shopifyShopId });
    });
    const live = observed.value;
    const [facts, receipts] = await Promise.all([
      this.local(input, [live?.planHandle, live?.pendingFlatRatePlan?.handle].filter((handle): handle is string => Boolean(handle))),
      live ? this.read(input, "read_purchase_receipts", async () => {
        const [latestPurchase, unresolvedPurchases] = await Promise.all([
          this.database.recoveryCreditPurchase.findFirst({ where: { shopId: input.shop.id, provider: "SHOPIFY" }, orderBy: { createdAt: "desc" }, include: { usageEvent: true } }),
          this.database.recoveryCreditPurchase.findMany({ where: { shopId: input.shop.id, provider: "SHOPIFY", status: "REQUESTED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { usageEvent: true } }),
        ]);
        return { latestPurchase, unresolvedPurchases };
      }) : Promise.resolve({ ok: true as const, value: null }),
    ]);
    const commercial = !observed.ok || !facts.plans.ok ? null : live
      ? projectMerchantShopifySubscription(live, facts.plans.value!)
      : { status: "NO_ACTIVE_SUBSCRIPTION" as const, subscription: null };
    const capacity = facts.valid ? await this.read(input, "project_capacity", async () => projectMerchantRecoveryCapacity({
      ...input, ...facts, selection: facts.selection.value,
    })) : null;
    const topUp = live && facts.valid && receipts.ok && receipts.value ? await this.read(input, "project_top_up", async () => projectMerchantBillingState({
      ...input, ...facts, providerSubscription: live,
      merchantPricingPlan: facts.pricing.value?.find(row => row.shopifyPlanHandle === live.planHandle) ?? null,
      ...receipts.value!,
    })) : null;
    // This existing route DTO is carried from the same plan batch even when a
    // capacity-only read fails; no second lookup is needed for the durable shell.
    const currentContract = facts.plan && input.subscription ? {
      shopifyPlanHandle: input.subscription.observedShopifyPlanHandle ?? facts.plan.shopifyPlanHandle,
      mappedModaPlanName: facts.plan.name, mappedModaPlanKind: facts.plan.kind === "FREE" ? "FREE" as const : "PAID_METERED" as const,
      currentPeriodStart: input.subscription.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: input.subscription.currentPeriodEnd?.toISOString() ?? null,
      cancelAtEndOfCycle: input.subscription.cancelAtPeriodEnd, price: null, interval: null,
    } : null;
    return { commercial, capacity: capacity?.value ?? null, topUp: topUp?.value ?? null, currentContract };
  }

  async readHome(input: MerchantHomeBillingReadInput): Promise<MerchantHomeBillingPresentation> {
    const facts = await this.local(input);
    const scalar = input.subscription;
    const subscription: MerchantHomeSubscriptionSummary = {
      status: scalar?.status ?? "NO_CONTRACT", planHandle: scalar?.observedShopifyPlanHandle ?? null,
      planName: facts.plan?.name ?? scalar?.observedShopifyPlanHandle ?? null,
      cancelAtEndOfCycle: scalar?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: scalar?.currentPeriodEnd?.toISOString() ?? null,
      pendingPlan: facts.pendingPlan ? { name: facts.pendingPlan.name, effectiveAt: scalar?.pendingEffectiveAt?.toISOString() ?? null } : null,
    };
    const capacity = facts.valid ? await this.read(input, "project_home_capacity", async () => projectMerchantRecoveryCapacity({
      ...input, ...facts, selection: facts.selection.value,
    })) : null;
    return { subscription, capacity: capacity?.value ?? null };
  }
}
