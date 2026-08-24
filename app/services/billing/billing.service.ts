import type {
  Subscription,
} from "@prisma/client";



import type {
  BillingProvider,
} from "./billing.types";

import {
  ShopifyBillingProvider,
} from "./providers/shopify-billing.provider";
import prisma from "../../db.server";


export class BillingService {
  constructor(
    private readonly provider: BillingProvider =
      new ShopifyBillingProvider(),
  ) {}

async getSubscription(
  shopId: string,
) {
  return prisma.subscription.findFirst({
    where: {
      shopId,

      status: {
        in: [
          "ACTIVE",
          "TRIALING",
        ],
      },
    },

    include: {
      plan: true,
    },

    orderBy: {
      createdAt: "desc",
    },
  });
}


  async syncSubscription(
    shopId: string,
  ): Promise<Subscription | null> {

    const shop =
      await prisma.shop.findUnique({
        where: {
          id: shopId,
        },
      });

    if (!shop) {
      throw new Error(
        `Shop ${shopId} was not found`,
      );
    }

    if (!shop.shopifyShopId) {
      throw new Error(
        `Shop ${shopId} does not have a Shopify shop ID`,
      );
    }

    const providerSubscription =
      await this.provider.getActiveSubscription({
        shopifyShopId:
          shop.shopifyShopId,
      });

    /*
     * Shopify says there is currently no
     * active subscription.
     */
    if (!providerSubscription) {
      await prisma.subscription.updateMany({
        where: {
          shopId,

          status: {
            in: [
              "ACTIVE",
              "TRIALING",
            ],
          },
        },

        data: {
          status: "CANCELLED",
          lastSyncedAt: new Date(),
        },
      });

      return null;
    }

    /*
     * Translate Shopify's plan handle into
     * our own BillingPlan.
     */
    const plan =
      await prisma.billingPlan.findUnique({
        where: {
          handle:
            providerSubscription.planHandle,
        },
      });

    if (!plan) {
      throw new Error(
        `No BillingPlan exists for Shopify plan '${providerSubscription.planHandle}'`,
      );
    }

    if (!plan.active) {
      throw new Error(
        `Billing plan '${plan.handle}' is inactive`,
      );
    }

    /*
     * There should be one current subscription
     * for the shop.
     *
     * Because we're retaining subscription history,
     * don't overwrite unrelated old subscriptions.
     */
    const existing =
      await prisma.subscription.findFirst({
        where: {
          shopId,

          status: {
            in: [
              "ACTIVE",
              "TRIALING",
            ],
          },
        },

        orderBy: {
          createdAt: "desc",
        },
      });

    const data = {
      planId: plan.id,

      provider:
        providerSubscription.provider,

      planHandle:
        providerSubscription.planHandle,

      status:
        providerSubscription.status,

      currentPeriodStart:
        providerSubscription.currentPeriodStart,

      currentPeriodEnd:
        providerSubscription.currentPeriodEnd,

      trialEndsAt:
        providerSubscription.trialEndsAt,

      cancelAtPeriodEnd:
        providerSubscription.cancelAtPeriodEnd,

      providerSubscriptionId:
        providerSubscription.providerSubscriptionId,

      lastSyncedAt:
        new Date(),
    };

    if (existing) {
      return prisma.subscription.update({
        where: {
          id: existing.id,
        },

        data,
      });
    }

    return prisma.subscription.create({
      data: {
        shopId,
        ...data,
      },
    });
  }
}


export const billingService =
  new BillingService();