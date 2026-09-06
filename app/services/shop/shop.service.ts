import type {
  AdminApiContext,
} from "@shopify/shopify-app-react-router/server";

import type {
  Shop,
} from "@prisma/client";
import {
  canonicaliseLanguageTag,
  normalizeCountryCode,
  normalizeTimeZone,
} from "@modainteract/moda-interact-shared/internationalization";

import prisma from "../../db.server";


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
   
    const shopifyShopId = shopifyGraphqlShop.shopifyShopId;

    const shop = await prisma.shop.upsert({
      where: {
        domain:
          shopifyGraphqlShop.myshopifyDomain,
      },

      create: {
        domain:
          shopifyGraphqlShop.myshopifyDomain,

        shopifyShopId:
          shopifyShopId,

        status: "ACTIVE",
      },

      update: {
        shopifyShopId:
          shopifyShopId,

        status: "ACTIVE",

        uninstalledAt: null,
      },
    });

    const primaryLocale =
      result.data?.shopLocales?.find(
        (shopLocale) => shopLocale.primary === true,
      )?.locale;

    await prisma.shopSettings.upsert({
      where: {
        shopId: shop.id,
      },
      create: {
        shopId: shop.id,
        defaultLanguageTag: normalizeOptional(
          primaryLocale,
          canonicaliseLanguageTag,
        ),
        defaultTimeZone: normalizeOptional(
          shopifyGraphqlShop.ianaTimezone,
          normalizeTimeZone,
        ),
        defaultCountryCode: normalizeOptional(
          shopifyGraphqlShop.shopAddress?.countryCodeV2,
          normalizeCountryCode,
        ),
      },
      update: {},
    });

    return shop;
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


  async markUninstalled(
    domain: string,
  ): Promise<void> {
    await prisma.shop.updateMany({
      where: {
        domain:
          normalizeShopDomain(domain),
      },

      data: {
        status: "UNINSTALLED",
        uninstalledAt: new Date(),
      },
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


export const shopService =
  new ShopService();