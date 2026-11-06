import { beforeEach, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

const mocks = vi.hoisted(() => ({
  shop: { findUnique: vi.fn(), upsert: vi.fn() },
  subscription: { findUnique: vi.fn() },
  shopSettings: { findUnique: vi.fn() },
  transaction: vi.fn(),
  authenticate: vi.fn(),
  createIntent: vi.fn(),
  catalogue: vi.fn(),
}));

vi.mock("../../app/db.server", () => ({ default: {
  shop: mocks.shop,
  subscription: mocks.subscription,
  shopSettings: mocks.shopSettings,
  $transaction: mocks.transaction,
} }));
vi.mock("../../app/services/feature-preferences/access.server", () => ({
  settingsMutationAccess: mocks.authenticate,
}));
vi.mock("../../app/services/merchant-knowledge/upload.server", () => ({
  createMerchantKnowledgeUploadIntent: mocks.createIntent,
}));
vi.mock("../../app/services/merchant-pricing/merchant-pricing.server", () => ({
  readActiveMerchantPricingCatalogue: mocks.catalogue,
}));
vi.mock("../../app/shopify.server", () => ({ login: vi.fn() }));

const { ShopService } = await import("../../app/services/shop/shop.service");
const { action: uploadIntentAction } = await import("../../app/routes/app/merchant-knowledge/upload-intent/route");
const { loader: homeLoader } = await import("../../app/routes/public/home/route");
const { loginErrorMessage } = await import("../../app/routes/auth/login/error.server");

const selectedShop = {
  id: "selected-shop-id",
  domain: "merchant.storefront.example",
  shopifyShopId: "gid://shopify/Shop/42",
  status: "ACTIVE",
  platform: "SHOPIFY",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shop.findUnique.mockResolvedValue({ ...selectedShop });
  mocks.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status: "ACTIVE" });
  mocks.shopSettings.findUnique.mockResolvedValue({ id: "settings-1" });
  mocks.transaction.mockImplementation(async (callback) => callback({}));
  mocks.authenticate.mockResolvedValue({ shop: selectedShop });
  mocks.createIntent.mockResolvedValue({ assetId: "asset-1", uploadUrl: "https://storage.invalid/signed" });
  mocks.catalogue.mockResolvedValue([]);
});

function profileAdmin(profile: Record<string, unknown>) {
  return { graphql: vi.fn(async () => Response.json({ data: {
    shop: {
      shopifyShopId: selectedShop.shopifyShopId,
      myshopifyDomain: "merchant.integration.example",
      ...profile,
    },
    shopLocales: [],
  } })) } as unknown as AdminApiContext;
}

it("accepts a provider profile with a custom storefront when its integration identity matches the SDK session", async () => {
  const admin = profileAdmin({ primaryDomain: { host: "merchant.storefront.example" } });
  const subscription = { id: "subscription-1", status: "ACTIVE" };
  const settings = { id: "settings-1" };
  mocks.shop.findUnique.mockResolvedValue({
    ...selectedShop,
    domain: "merchant.integration.example",
    storeLocale: null,
    defaultLanguageTag: null,
    defaultTimeZone: null,
    defaultCountryCode: null,
  });
  mocks.subscription.findUnique.mockResolvedValue(subscription);
  mocks.shopSettings.findUnique.mockResolvedValue(settings);

  const result = await new ShopService().resolveShopifyMerchantSnapshot({
    admin,
    sessionShop: "merchant.integration.example",
  });

  expect(result.shop.shopifyShopId).toBe("gid://shopify/Shop/42");
  expect(mocks.shop.findUnique).toHaveBeenCalledWith({ where: { domain: "merchant.integration.example" } });
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it("rejects a provider integration identity that differs from the SDK session shop", async () => {
  const admin = profileAdmin({ primaryDomain: { host: "merchant.storefront.example" } });

  await expect(new ShopService().resolveShopifyMerchantSnapshot({
    admin,
    sessionShop: "another.integration.example",
  })).rejects.toThrow("Shop domain mismatch in authenticated merchant profile");

  expect(mocks.shop.findUnique).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it("leaves custom storefront input to Shopify and performs no public discovery", async () => {
  const result = await homeLoader({
    request: new Request("https://app.example/?shop=merchant.storefront.example"),
  } as Parameters<typeof homeLoader>[0]);

  expect(result).not.toHaveProperty("detectedShop");
  expect(mocks.catalogue).toHaveBeenCalledOnce();
  expect(mocks.authenticate).not.toHaveBeenCalled();
  expect(mocks.createIntent).not.toHaveBeenCalled();
  expect(loginErrorMessage({ shop: LoginErrorType.InvalidShop }).shop).toContain("Shopify admin");
});

it("binds an authorized upload to the authenticated selected Shop ID and rejects a foreign ID in the body", async () => {
  const body = {
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "CSV",
    originalFileName: "catalog.csv",
    contentType: "text/csv",
    sizeBytes: 32,
  };
  const request = () => new Request("https://app.example/app/merchant-knowledge/upload-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const success = await uploadIntentAction({ request: request(), context: {} } as never);
  expect(success).toBeInstanceOf(Response);
  expect(mocks.createIntent).toHaveBeenCalledWith({ shopId: selectedShop.id, ...body });

  mocks.createIntent.mockClear();
  const foreign = await uploadIntentAction({
    request: new Request("https://app.example/app/merchant-knowledge/upload-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, shopId: "foreign-shop-id", shopDomain: "custom.attacker.example" }),
    }),
    context: {},
  } as never) as Response;

  expect(foreign.status).toBe(400);
  expect(mocks.createIntent).not.toHaveBeenCalled();
});
