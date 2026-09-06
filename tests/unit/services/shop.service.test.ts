import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const shop = {
  id: "shop_1",
  domain: "shop.myshopify.com",
  shopifyShopId: "gid://shopify/Shop/1",
  status: "ACTIVE",
};

const dbMock = {
  shop: {
    upsert: vi.fn(),
  },
  shopSettings: {
    upsert: vi.fn(),
  },
};

vi.mock("../../../app/db.server", () => ({
  default: dbMock,
}));

const { ShopService } = await import(
  "../../../app/services/shop/shop.service"
);

function adminFor(shopData: Record<string, unknown>) {
  return {
    graphql: vi.fn(async () => ({
      json: async () => ({
        data: {
          shop: shopData,
          shopLocales: (shopData as { shopLocales?: unknown }).shopLocales,
        },
      }),
    })),
  } as unknown as AdminApiContext;
}

beforeEach(() => {
  dbMock.shop.upsert.mockReset();
  dbMock.shopSettings.upsert.mockReset();
  dbMock.shop.upsert.mockResolvedValue(shop);
  dbMock.shopSettings.upsert.mockResolvedValue({
    shopId: shop.id,
  });
});

describe("ShopService.resolveShopifyShop", () => {
  it("creates settings from the primary Shopify locale and store context", async () => {
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      ianaTimezone: "Europe/London",
      shopAddress: { countryCodeV2: "GB" },
      shopLocales: [
        { locale: "en-GB", primary: false, published: true },
        { locale: "fr-CA", primary: true, published: true },
      ],
    });

    await new ShopService().resolveShopifyShop({
      admin,
      domain: shop.domain,
    });

    expect(dbMock.shopSettings.upsert).toHaveBeenCalledWith({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        defaultLanguageTag: "fr-CA",
        defaultTimeZone: "Europe/London",
        defaultCountryCode: "GB",
      },
      update: {},
    });

    const query = admin.graphql.mock.calls[0]?.[0] as string;
    expect(query).toContain("shopLocales");
    expect(query).toMatch(
      /shop \{[\s\S]*shopAddress \{[\s\S]*\}\s*\}\s*shopLocales \{/,
    );
    expect(query).toContain("            }\n          }\n          shopLocales {");
    expect(query).not.toContain("currency");
    expect(query).not.toContain("Session.locale");
  });

  it("does not overwrite merchant settings on repeated resolution", async () => {
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      ianaTimezone: "America/Toronto",
      shopAddress: { countryCodeV2: "CA" },
      shopLocales: [{ locale: "fr-CA", primary: true, published: true }],
    });

    await new ShopService().resolveShopifyShop({
      admin,
      domain: shop.domain,
    });

    expect(dbMock.shopSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
  });

  it("stores null for missing or invalid optional Shopify values", async () => {
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      ianaTimezone: "Not/A-Timezone",
      shopAddress: { countryCodeV2: "XX" },
      shopLocales: [{ locale: "!!!", primary: true, published: true }],
    });

    await new ShopService().resolveShopifyShop({
      admin,
      domain: shop.domain,
    });

    expect(dbMock.shopSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          shopId: shop.id,
          defaultLanguageTag: null,
          defaultTimeZone: null,
          defaultCountryCode: null,
        },
      }),
    );
  });
});
