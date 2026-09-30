import { describe, expect, it } from "vitest";
import {
  ARCH023_LOCALES,
  validateStoreCategoryLocales,
} from "../../scripts/validate-arch023-store-category-locales.mjs";
import { createMerchantI18n } from "../../app/utils/merchant-i18n.js";

const english = {
  "storeProfile.categories.home-goods.displayName": "Home goods",
  "storeProfile.categories.home-goods.description": "Home and everyday products.",
  "merchantKnowledge.purposes.COMPANY_INFORMATION.label": "Company information",
  "merchantKnowledge.purposes.CUSTOMER_SUPPORT.label": "Customer support",
  "merchantKnowledge.purposes.POLICIES.label": "Policies",
  "merchantKnowledge.purposes.FAQ.label": "Frequently asked questions",
  "merchantKnowledge.purposes.PRODUCT_INFORMATION.label": "Product information",
  "merchantKnowledge.purposes.SHIPPING_AND_DELIVERY.label": "Shipping and delivery",
  "merchantKnowledge.purposes.PRICING.label": "Pricing",
  "merchantKnowledge.dataFormats.WEB_PAGE.label": "Web page",
  "merchantKnowledge.dataFormats.CSV.label": "CSV spreadsheet",
  "merchantKnowledge.dataFormats.XLSX.label": "Excel spreadsheet (.xlsx)",
};
const completeCatalogues = () => Object.fromEntries(
  ARCH023_LOCALES.map((locale) => [locale, { ...english }]),
);

describe("ARCH-023 locale manifest validation", () => {
  it("loads every supported merchant catalogue through the ICU runtime", () => {
    for (const locale of ARCH023_LOCALES)
      expect(() => createMerchantI18n({ locale })).not.toThrow();
  });

  it("requires every category and Merchant Knowledge key in all supported locales", () => {
    const catalogues = completeCatalogues();
    delete catalogues["zh-Hans"]["storeProfile.categories.home-goods.description"];
    delete catalogues.fr["merchantKnowledge.dataFormats.XLSX.label"];

    expect(() => validateStoreCategoryLocales(english, catalogues)).toThrow(
      "zh-Hans catalogue is missing storeProfile.categories.home-goods.description",
    );
    catalogues["zh-Hans"]["storeProfile.categories.home-goods.description"] = "Home and everyday products.";
    expect(() => validateStoreCategoryLocales(english, catalogues)).toThrow(
      "fr catalogue is missing merchantKnowledge.dataFormats.XLSX.label",
    );
  });
});