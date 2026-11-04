import type { PrismaClient } from "@prisma/client";

import prisma from "../../db.server";
import { logBillingBoundaryFailure } from "./providers/shopify-billing-diagnostics.server";

export async function persistShopifyOnboardingMilestone(
  shopId: string,
  database: Pick<PrismaClient, "$transaction"> = prisma,
): Promise<void> {
  try {
    await database.$transaction(async (transaction) => {
      const shop = await transaction.shop.updateMany({
        where: { id: shopId },
        data: { onboardingCompleted: true },
      });
      if (shop.count !== 1) {
        throw new Error(`Unable to mark onboarding complete for Shop ${shopId}`);
      }

      const settings = await transaction.shopSettings.updateMany({
        where: { shopId },
        data: { onboardingCompleted: true },
      });
      if (settings.count !== 1) {
        throw new Error(`ShopSettings invariant missing for Shop ${shopId}`);
      }
    });
  } catch (error) {
    logBillingBoundaryFailure({
      event: "billing.onboarding_milestone.persist_failed",
      operation: "persist_shopify_onboarding_milestone",
      stage: "two_row_transaction",
      shopId,
      error,
    });
    throw error;
  }
}
