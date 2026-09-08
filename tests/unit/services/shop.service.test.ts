import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const shop = {
  id: "shop_1",
  domain: "shop.myshopify.com",
  shopifyShopId: "gid://shopify/Shop/1",
  status: "ACTIVE",
};

const dbMock = {
  $transaction: vi.fn(),
  shop: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  subscription: {
    updateMany: vi.fn(),
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
  dbMock.$transaction.mockReset();
  dbMock.shop.findUnique.mockReset();
  dbMock.shop.upsert.mockReset();
  dbMock.shop.updateMany.mockReset();
  dbMock.subscription.updateMany.mockReset();
  dbMock.shopSettings.upsert.mockReset();
  dbMock.$transaction.mockImplementation(async (callback) => callback(dbMock));
  dbMock.shop.upsert.mockResolvedValue(shop);
  dbMock.shopSettings.upsert.mockResolvedValue({
    shopId: shop.id,
  });
});

describe("ShopService.markUninstalled", () => {
  it("marks the shop and disables new subscription admission", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: shop.id });
    const uninstalledAt = new Date("2026-09-08T10:00:00.000Z");

    await new ShopService().markUninstalled(shop.domain, uninstalledAt);

    expect(dbMock.shop.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: shop.id, uninstalledAt: null },
      data: { status: "UNINSTALLED", uninstalledAt },
    });
    expect(dbMock.subscription.updateMany).toHaveBeenCalledWith({
      where: { shopId: shop.id },
      data: { status: "NO_CONTRACT" },
    });
  });

  it("uses a conditional cutoff write for duplicate delivery", async () => {
    dbMock.shop.findUnique.mockResolvedValue({ id: shop.id });
    const uninstalledAt = new Date("2026-09-08T11:00:00.000Z");

    await new ShopService().markUninstalled(shop.domain, uninstalledAt);

    expect(dbMock.shop.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: shop.id, uninstalledAt: null },
      data: { status: "UNINSTALLED", uninstalledAt },
    });
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
