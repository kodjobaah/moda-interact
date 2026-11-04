import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

export async function createPaidActivationFixture(
  database: PrismaClient,
  label: string,
) {
  const suffix = `${label}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const shopId = `${suffix}-shop`;
  const planId = `${suffix}-billing-plan`;
  const planHandle = `${suffix}-growth`;
  const merchantPricingPlanId = `${suffix}-quote`;

  await database.shop.create({
    data: {
      id: shopId,
      domain: `${suffix}.myshopify.com`,
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      platform: "SHOPIFY",
      status: "ACTIVE",
      settings: { create: { onboardingCompleted: false } },
    },
  });
  await database.billingPlan.create({
    data: {
      id: planId,
      shopifyPlanHandle: planHandle,
      name: "Activation integration plan",
      kind: "PAID_METERED",
      active: true,
      shopifyUsageEventHandle: `${suffix}-message-meter`,
      includedRecoveryConversationAllowance: 25,
    },
  });
  const lastCataloguePlan = await database.merchantPricingPlan.findFirst({
    orderBy: { cataloguePosition: "desc" },
    select: { cataloguePosition: true },
  });
  await database.merchantPricingPlan.create({
    data: {
      id: merchantPricingPlanId,
      shopifyPlanHandle: planHandle,
      displayName: "Activation integration quote",
      planKind: "PAID_METERED",
      isActive: true,
      cataloguePosition: (lastCataloguePlan?.cataloguePosition ?? -1) + 1,
      includedRecoveryCredits: 25,
      allowancePeriod: "EVERY_30_DAYS",
      billingPeriod: "EVERY_30_DAYS",
      recurringAmountMinor: 1200,
      currency: "USD",
      translations: {
        create: ["cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant"].map((locale) => ({
          locale,
          merchantDescription: "Activation integration plan",
        })),
      },
    },
  });
  await database.platformBillingPolicy.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      absoluteOutboundHardLimit: 2000,
      defaultWarningPercent: 80,
    },
  });

  return {
    shopId,
    planId,
    planHandle,
    usageEventHandle: `${suffix}-message-meter`,
    merchantPricingPlanId,
  };
}
