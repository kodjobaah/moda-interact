import type { BillingPlan, PrismaClient } from "@prisma/client";
import { BillingPlanKind, Prisma } from "@prisma/client";
import {
  MerchantKnowledgeFeatureConfigurationSchema,
} from "@modainteract/moda-interact-shared/merchant-knowledge";

import {
  readMerchantPricingPlanForProvider,
} from "../merchant-pricing/merchant-pricing.server.js";

export type OperationalBillingPlanResolution =
  | { kind: "READY"; plan: BillingPlan; materialized: boolean }
  | { kind: "UNKNOWN_CATALOGUE_PLAN" }
  | { kind: "INACTIVE_OPERATIONAL_PLAN"; planId: string }
  | { kind: "INVALID_CATALOGUE_PLAN"; reason: string };

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002",
  );
}

export class BillingPlanResolutionService {
  constructor(private readonly database: PrismaClient) {}

  async resolveOrMaterializeBillingPlan(
    planHandle: string,
  ): Promise<OperationalBillingPlanResolution> {
    try {
      return await this.database.$transaction(async (transaction) => {
        const existing = await transaction.billingPlan.findUnique({
          where: { shopifyPlanHandle: planHandle },
        });
        if (existing) {
          if (!existing.active) {
            return { kind: "INACTIVE_OPERATIONAL_PLAN", planId: existing.id };
          }
          const catalogue = await transaction.merchantPricingPlan.findUnique({
            where: { shopifyPlanHandle: planHandle },
            select: { materializedAt: true },
          });
          if (catalogue?.materializedAt === null) {
            await transaction.merchantPricingPlan.updateMany({
              where: { shopifyPlanHandle: planHandle, materializedAt: null },
              data: { materializedAt: new Date() },
            });
          }
          return { kind: "READY", plan: existing, materialized: false };
        }

        const catalogue = await transaction.merchantPricingPlan.findUnique({
          where: { shopifyPlanHandle: planHandle },
          include: { features: { include: { feature: true } } },
        });
        if (!catalogue || !catalogue.isActive) {
          return { kind: "UNKNOWN_CATALOGUE_PLAN" };
        }

        const invalidReason = catalogue.planKind !== "FREE" && catalogue.planKind !== "PAID_METERED"
          ? "INVALID_PLAN_KIND"
          : !catalogue.features.some((mapping) =>
              mapping.feature?.key === "checkout_recovery" && mapping.feature.systemRequired,
            )
            ? "MISSING_CHECKOUT_RECOVERY_FEATURE"
            : catalogue.features.some((mapping) => !mapping.feature)
              ? "MISSING_FEATURE_MAPPING"
              : catalogue.planKind === "FREE" && catalogue.shopifyRecoveryUsageEventHandle !== null
                ? "FREE_PLAN_HAS_RECOVERY_USAGE_METER"
                : catalogue.planKind === "PAID_METERED" &&
                    !(typeof catalogue.shopifyRecoveryUsageEventHandle === "string" && catalogue.shopifyRecoveryUsageEventHandle.trim())
                  ? "PAID_PLAN_MISSING_RECOVERY_USAGE_METER"
                  : !Number.isSafeInteger(catalogue.includedRecoveryCredits) || catalogue.includedRecoveryCredits < 0
                    ? "INVALID_INCLUDED_RECOVERY_CREDITS"
                    : null;
        if (invalidReason) {
          return { kind: "INVALID_CATALOGUE_PLAN", reason: invalidReason };
        }

        const merchantKnowledgeMappings = catalogue.features.filter((mapping) =>
          mapping.feature?.key === "merchant_knowledge",
        );
        if (merchantKnowledgeMappings.length > 0) {
          if (merchantKnowledgeMappings.length !== 1) {
            return {
              kind: "INVALID_CATALOGUE_PLAN",
              reason: "INVALID_MERCHANT_KNOWLEDGE_CONFIGURATION",
            };
          }
          const configuration = MerchantKnowledgeFeatureConfigurationSchema.safeParse(
            merchantKnowledgeMappings[0].configuration,
          );
          if (!configuration.success) {
            return {
              kind: "INVALID_CATALOGUE_PLAN",
              reason: "INVALID_MERCHANT_KNOWLEDGE_CONFIGURATION",
            };
          }
          const activeCompatibilityRows = await transaction.merchantKnowledgePurposeDataFormat.findMany({
            where: {
              purpose: { is: { active: true } },
              dataFormat: { is: { active: true } },
            },
            select: {
              purpose: { select: { key: true } },
              dataFormat: { select: { key: true } },
            },
          });
          const activePairs = new Set(activeCompatibilityRows.map((row) =>
            `${row.purpose.key}\u0000${row.dataFormat.key}`,
          ));
          if (configuration.data.allowedSourceTypes.some((sourceType) =>
            !activePairs.has(`${sourceType.purposeKey}\u0000${sourceType.dataFormatKey}`),
          )) {
            return {
              kind: "INVALID_CATALOGUE_PLAN",
              reason: "INVALID_MERCHANT_KNOWLEDGE_CONFIGURATION",
            };
          }
        }

        const kind = catalogue.planKind === "FREE"
          ? BillingPlanKind.FREE
          : BillingPlanKind.PAID_METERED;
        const plan = await transaction.billingPlan.create({
          data: {
            shopifyPlanHandle: catalogue.shopifyPlanHandle,
            name: catalogue.displayName,
            kind,
            active: true,
            shopifyUsageEventHandle: kind === BillingPlanKind.FREE
              ? null
              : catalogue.shopifyRecoveryUsageEventHandle!.trim(),
            includedRecoveryConversationAllowance: kind === BillingPlanKind.FREE
              ? null
              : catalogue.includedRecoveryCredits,
            recoveryCreditPackEnabled: false,
            recoveryCreditsPerPack: null,
            shopifyRecoveryCreditPackEventHandle: null,
            features: {
              create: catalogue.features.map((mapping) => ({
                featureId: mapping.featureId,
                enabled: true,
                configuration: mapping.configuration === null
                  ? Prisma.JsonNull
                  : mapping.configuration as Prisma.InputJsonValue,
              })),
            },
          },
        });
        if (catalogue.materializedAt === null) {
          await transaction.merchantPricingPlan.updateMany({
            where: { shopifyPlanHandle: planHandle, materializedAt: null },
            data: { materializedAt: new Date() },
          });
        }
        return { kind: "READY", plan, materialized: true };
      });
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) throw error;

      return this.database.$transaction(async (transaction) => {
        const winner = await transaction.billingPlan.findUnique({
          where: { shopifyPlanHandle: planHandle },
        });
        if (!winner) throw error;
        if (!winner.active) {
          return { kind: "INACTIVE_OPERATIONAL_PLAN", planId: winner.id };
        }
        const catalogue = await transaction.merchantPricingPlan.findUnique({
          where: { shopifyPlanHandle: planHandle },
          select: { materializedAt: true },
        });
        if (catalogue?.materializedAt === null) {
          await transaction.merchantPricingPlan.updateMany({
            where: { shopifyPlanHandle: planHandle, materializedAt: null },
            data: { materializedAt: new Date() },
          });
        }
        return { kind: "READY", plan: winner, materialized: false };
      });
    }
  }

  async readRecoveryCreditTopUpConfiguration(planHandle: string | null | undefined) {
    if (!planHandle || !this.database.merchantPricingPlan?.findUnique) {
      return { enabled: false, creditsPerPack: null as number | null };
    }
    const plan = await this.database.merchantPricingPlan.findUnique({
      where: { shopifyPlanHandle: planHandle },
      select: {
        usageEvents: {
          orderBy: { position: "asc" },
          select: { creditsGrantedPerUnit: true },
        },
      },
    });
    const usageEvents = plan?.usageEvents ?? [];
    const credits = [...new Set(usageEvents
      .map((event: { creditsGrantedPerUnit: number }) => event.creditsGrantedPerUnit)
      .filter((value: number) => Number.isSafeInteger(value) && value > 0))];
    return {
      enabled: usageEvents.length > 0,
      creditsPerPack: credits.length === 1 ? credits[0] : null,
    };
  }

  async readMerchantPricingPlan(planHandle: string) {
    if (this.database.merchantPricingPlan?.findUnique) {
      const plan = await this.database.merchantPricingPlan.findUnique({
        where: { shopifyPlanHandle: planHandle },
        include: { usageEvents: { orderBy: { position: "asc" }, include: { tiers: { orderBy: { position: "asc" } } } } },
      });
      return plan
        ? {
            shopifyPlanHandle: plan.shopifyPlanHandle,
            usageEvents: plan.usageEvents.map((event: { position: number; eventHandle: string; adminLabel: string; creditsGrantedPerUnit: number }) => ({
              cataloguePosition: event.position,
              eventHandle: event.eventHandle,
              adminLabel: event.adminLabel,
              creditsGrantedPerUnit: event.creditsGrantedPerUnit,
            })),
          }
        : null;
    }
    return readMerchantPricingPlanForProvider({ planHandle });
  }
}