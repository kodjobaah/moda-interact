import type {
  AdminApiContext,
} from "@shopify/shopify-app-react-router/server";

import type {
  Prisma,
  Shop,
} from "@prisma/client";
import {
  canonicaliseLanguageTag,
  normalizeCountryCode,
  normalizeTimeZone,
} from "@modainteract/moda-interact-shared/internationalization";

import prisma from "../../db.server";
import {
  lockShopLifecycleRow,
  markDiscountCatalogueUnavailable,
} from "../discounts/shopify-discount-lifecycle.service";


export interface ResolveShopifyShopInput {
  admin: AdminApiContext;
  domain: string;
}


interface ShopifyShopResponse {
  data?: {
    shop?: {
      shopifyShopId?: string | null;
      myshopifyDomain?: string | null;
      ianaTimezone?: string | null;
      shopAddress?: {
        countryCodeV2?: string | null;
      } | null;
    } | null;
    shopLocales?: Array<{
      locale?: string | null;
      primary?: boolean | null;
      published?: boolean | null;
    }> | null;
  };
}


export class ShopService {
  async resolveShopifyShop({
    admin,
    domain,
  }: ResolveShopifyShopInput): Promise<Shop> {
    const response = await admin.graphql(
      `#graphql
        query ResolveModaInteractShop {
          shop {
            shopifyShopId: id
            myshopifyDomain
            ianaTimezone
            shopAddress {
              countryCodeV2
            }
          }
          shopLocales {
            locale
            primary
            published
          }
        }
      `,
    );

    const result =
      (await response.json()) as ShopifyShopResponse;

    const shopifyGraphqlShop =
      result.data?.shop;

    if (
      !shopifyGraphqlShop?.shopifyShopId ||
      !shopifyGraphqlShop.myshopifyDomain
    ) {
      throw new Error(
        `Unable to resolve Shopify shop identity for ${domain}`,
      );
    }
    
    /*
     * The authenticated session domain and Shopify's
     * canonical myshopifyDomain should represent the
     * same shop.
     */
    if (
      normalizeShopDomain(
        shopifyGraphqlShop.myshopifyDomain,
      ) !== normalizeShopDomain(domain)
    ) {
      throw new Error(
        `Shop domain mismatch. Session=${domain}, Shopify=${shopifyGraphqlShop.myshopifyDomain}`,
      );
    }
   
    const shopDomain = shopifyGraphqlShop.myshopifyDomain;
    const shopifyShopId = shopifyGraphqlShop.shopifyShopId;
    const primaryLocale =
      result.data?.shopLocales?.find(
        (shopLocale) => shopLocale.primary === true,
      )?.locale;
    const storeLocale = normalizeStoreLocale(primaryLocale);
    const defaultLanguageTag = normalizeOptional(
      primaryLocale,
      canonicaliseLanguageTag,
    );
    const defaultTimeZone = normalizeOptional(
      shopifyGraphqlShop.ianaTimezone,
      normalizeTimeZone,
    );
    const defaultCountryCode = normalizeOptional(
      shopifyGraphqlShop.shopAddress?.countryCodeV2,
      normalizeCountryCode,
    );
    const updateContext = {
      ...(storeLocale ? { storeLocale } : {}),
      ...(defaultLanguageTag ? { defaultLanguageTag } : {}),
      ...(defaultTimeZone ? { defaultTimeZone } : {}),
      ...(defaultCountryCode ? { defaultCountryCode } : {}),
    };
    const settingsUpdateContext = {
      ...(defaultLanguageTag ? { defaultLanguageTag } : {}),
      ...(defaultTimeZone ? { defaultTimeZone } : {}),
      ...(defaultCountryCode ? { defaultCountryCode } : {}),
    };

    const existingShop = await prisma.shop.findUnique({
      where: { domain: shopDomain },
    });
    const [existingSubscription, existingSettings] = existingShop
      ? await Promise.all([
          prisma.subscription.findUnique({
            where: { shopId: existingShop.id },
            select: { id: true },
          }),
          prisma.shopSettings.findUnique({
            where: { shopId: existingShop.id },
            select: {
              id: true,
              defaultLanguageTag: true,
              defaultTimeZone: true,
              defaultCountryCode: true,
            },
          }),
        ])
      : [null, null];
    const shopNeedsRefresh = existingShop !== null && (
      existingShop.shopifyShopId !== shopifyShopId ||
      (storeLocale !== null && existingShop.storeLocale !== storeLocale) ||
      (defaultLanguageTag !== null && existingShop.defaultLanguageTag !== defaultLanguageTag) ||
      (defaultTimeZone !== null && existingShop.defaultTimeZone !== defaultTimeZone) ||
      (defaultCountryCode !== null && existingShop.defaultCountryCode !== defaultCountryCode)
    );
    const settingsNeedsRefresh = existingSettings !== null && (
      (defaultLanguageTag !== null && existingSettings.defaultLanguageTag !== defaultLanguageTag) ||
      (defaultTimeZone !== null && existingSettings.defaultTimeZone !== defaultTimeZone) ||
      (defaultCountryCode !== null && existingSettings.defaultCountryCode !== defaultCountryCode)
    );

    if (existingShop && existingSubscription && existingSettings) {
      if (!shopNeedsRefresh && !settingsNeedsRefresh) {
        return existingShop;
      }

      return prisma.$transaction(async (transaction) => {
        const shop = shopNeedsRefresh
          ? await transaction.shop.update({
              where: { id: existingShop.id },
              data: {
                shopifyShopId,
                ...updateContext,
              },
            })
          : existingShop;

        if (settingsNeedsRefresh) {
          await transaction.shopSettings.update({
            where: { shopId: existingShop.id },
            data: settingsUpdateContext,
          });
        }

        return shop;
      });
    }

    return prisma.$transaction(async (transaction) => {
      const shop = await transaction.shop.upsert({
        where: { domain: shopDomain },
        create: {
          domain: shopDomain,
          shopifyShopId,
          status: "ACTIVE",
          storeLocale,
          defaultLanguageTag,
          defaultTimeZone,
          defaultCountryCode,
        },
        update: {
          shopifyShopId,
          ...updateContext,
        },
      });

      if (!existingSubscription) {
        await transaction.subscription.upsert({
          where: { shopId: shop.id },
          create: {
            shopId: shop.id,
            status: "NO_CONTRACT",
            planId: null,
            observedShopifyPlanHandle: null,
            billingPeriodId: null,
            currentPeriodStart: null,
            currentPeriodEnd: null,
            trialEndsAt: null,
            cancelAtPeriodEnd: false,
            providerSubscriptionId: null,
            pendingShopifyPlanHandle: null,
            pendingPlanId: null,
            pendingEffectiveAt: null,
          },
          update: {},
        });
      }

      if (!existingSettings) {
        await transaction.shopSettings.upsert({
          where: { shopId: shop.id },
          create: {
            shopId: shop.id,
            defaultLanguageTag,
            defaultTimeZone,
            defaultCountryCode,
          },
          update: settingsUpdateContext,
        });
      } else if (settingsNeedsRefresh) {
        await transaction.shopSettings.update({
          where: { shopId: shop.id },
          data: settingsUpdateContext,
        });
      }

      return shop;
    });
  }


  async getById(
    shopId: string,
  ): Promise<Shop | null> {
    return prisma.shop.findUnique({
      where: {
        id: shopId,
      },
    });
  }


  async getByDomain(
    domain: string,
  ): Promise<Shop | null> {
    return prisma.shop.findUnique({
      where: {
        domain:
          normalizeShopDomain(domain),
      },
    });
  }


  async beginReinstallReconciliation(
    shopId: string,
    now = new Date(),
  ): Promise<{
    shopId: string;
    subscriptionId: string;
    reinstallPendingAt: Date;
    expectedNextReconcileAt: Date;
  } | null> {
    return prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
      const shop = await transaction.shop.findUnique({
        where: { id: shopId },
        select: { status: true, reinstallPendingAt: true },
      });
      if (!shop || shop.status !== "UNINSTALLED") return null;

      const existingSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: { id: true, nextReconcileAt: true },
      });

      if (shop.reinstallPendingAt) {
        if (!existingSubscription?.nextReconcileAt) return null;

        return {
          shopId,
          subscriptionId: existingSubscription.id,
          reinstallPendingAt: shop.reinstallPendingAt,
          expectedNextReconcileAt: existingSubscription.nextReconcileAt,
        };
      }

      const reinstallPendingAt = now;
      const markerWrite = await transaction.shop.updateMany({
          where: {
            id: shopId,
            status: "UNINSTALLED",
            reinstallPendingAt: null,
          },
          data: { reinstallPendingAt },
      });

      if (markerWrite.count !== 1) {
        const durableShop = await transaction.shop.findUnique({
          where: { id: shopId },
          select: { status: true, reinstallPendingAt: true },
        });
        const durableSubscription = await transaction.subscription.findUnique({
          where: { shopId },
          select: { id: true, nextReconcileAt: true },
        });

        if (
          durableShop?.status !== "UNINSTALLED" ||
          !durableShop.reinstallPendingAt ||
          !durableSubscription?.nextReconcileAt
        ) {
          return null;
        }

        return {
          shopId,
          subscriptionId: durableSubscription.id,
          reinstallPendingAt: durableShop.reinstallPendingAt,
          expectedNextReconcileAt: durableSubscription.nextReconcileAt,
        };
      }

      const subscription = await transaction.subscription.upsert({
        where: { shopId },
        update: { nextReconcileAt: now },
        create: {
          shopId,
          status: "NO_CONTRACT",
          planId: null,
          observedShopifyPlanHandle: null,
          nextReconcileAt: now,
        },
        select: { id: true, nextReconcileAt: true },
      });

      if (!subscription.nextReconcileAt) {
        throw new Error("Reinstall reconciliation schedule was not persisted.");
      }

      return {
        shopId,
        subscriptionId: subscription.id,
        reinstallPendingAt,
        expectedNextReconcileAt: subscription.nextReconcileAt,
      };
    });
  }

  async retryReinstallReconciliation(
    shopId: string,
    now = new Date(),
  ): Promise<{
    shopId: string;
    subscriptionId: string;
    reinstallPendingAt: Date;
    expectedNextReconcileAt: Date;
  } | null> {
    return prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
      const shop = await transaction.shop.findUnique({
        where: { id: shopId },
        select: { status: true, reinstallPendingAt: true },
      });
      if (!shop || shop.status !== "UNINSTALLED" || !shop.reinstallPendingAt) {
        return null;
      }

      const subscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: { id: true, nextReconcileAt: true },
      });
      if (subscription?.nextReconcileAt) return null;

      const markerWrite = await transaction.shop.updateMany({
        where: {
          id: shopId,
          status: "UNINSTALLED",
          reinstallPendingAt: shop.reinstallPendingAt,
        },
        data: { reinstallPendingAt: now },
      });
      if (markerWrite.count !== 1) return null;

      const updatedSubscription = await transaction.subscription.upsert({
        where: { shopId },
        update: { nextReconcileAt: now },
        create: {
          shopId,
          status: "NO_CONTRACT",
          planId: null,
          observedShopifyPlanHandle: null,
          nextReconcileAt: now,
        },
        select: { id: true, nextReconcileAt: true },
      });

      if (!updatedSubscription.nextReconcileAt) {
        throw new Error("Reinstall retry schedule was not persisted.");
      }

      return {
        shopId,
        subscriptionId: updatedSubscription.id,
        reinstallPendingAt: now,
        expectedNextReconcileAt: updatedSubscription.nextReconcileAt,
      };
    });
  }

  async getReinstallSubscription(shopId: string) {
    return prisma.subscription.findUnique({
      where: { shopId },
      select: { nextReconcileAt: true },
    });
  }


  async markUninstalled(
    domain: string,
    uninstalledAt: Date,
  ): Promise<void> {
    const normalizedDomain = normalizeShopDomain(domain);

    await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
      const shopIdentity = await transaction.shop.findUnique({
        where: { domain: normalizedDomain },
        select: { id: true },
      });

      if (!shopIdentity) {
        return;
      }

      await lockShopLifecycleRow(transaction, shopIdentity.id);
      const shop = await transaction.shop.findUnique({
        where: { id: shopIdentity.id },
        select: { id: true, uninstalledAt: true },
      });
      if (!shop) return;

      await transaction.shop.updateMany({
        where: {
          id: shop.id,
          uninstalledAt: null,
        },
        data: {
          status: "UNINSTALLED",
          uninstalledAt,
          reinstallPendingAt: null,
        },
      });

      await markDiscountCatalogueUnavailable(
        transaction,
        shop.id,
        shop.uninstalledAt ?? uninstalledAt,
      );

    });
  }
}


function normalizeShopDomain(
  domain: string,
): string {
  return domain
    .trim()
    .toLowerCase();
}


function normalizeOptional(
  value: string | null | undefined,
  normalize: (value: string) => string,
): string | null {
  if (!value) {
    return null;
  }

  try {
    return normalize(value);
  } catch {
    return null;
  }
}

function normalizeStoreLocale(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const locale = value.trim();
  if (!locale || locale.length > 128) return null;
  try {
    new Intl.Locale(locale);
    return locale;
  } catch {
    return null;
  }
}


export const shopService =
  new ShopService();