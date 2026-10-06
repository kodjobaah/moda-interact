import { describe, expect, it } from "vitest";
import {
  localizeStoreCategory,
  localizeStoreCategoryMapping,
  resolveStoreCategoryLocale,
  storeCategoryTranslationLocales,
} from "../../app/services/store-profile/store-category-localization";

describe("database-backed Store Category localization", () => {
  it("normalizes merchant locales to the supported database locale contract", () => {
    expect(resolveStoreCategoryLocale("de-DE")).toBe("de");
    expect(resolveStoreCategoryLocale("pt-BR")).toBe("pt-BR");
    expect(resolveStoreCategoryLocale("zh-TW")).toBe("zh-Hant");
    expect(resolveStoreCategoryLocale("ar-EG")).toBe("en");
    expect(storeCategoryTranslationLocales("de-DE")).toEqual(["de", "en"]);
    expect(storeCategoryTranslationLocales("en-GB")).toEqual(["en"]);
  });

  it("prefers the requested database translation then English then canonical category metadata", () => {
    const category = {
      id: "category-apparel",
      displayName: "Canonical Apparel",
      description: "Canonical description",
      translations: [
        { locale: "en", displayName: "Apparel", description: "English description" },
        { locale: "de", displayName: "Bekleidung", description: "Deutsche Beschreibung" },
      ],
    };

    expect(localizeStoreCategory(category, "de-DE")).toEqual({
      localizedDisplayName: "Bekleidung",
      localizedDescription: "Deutsche Beschreibung",
    });
    expect(localizeStoreCategory(category, "fr-FR")).toEqual({
      localizedDisplayName: "Apparel",
      localizedDescription: "English description",
    });
    expect(localizeStoreCategory({ ...category, translations: [] }, "fr-FR")).toEqual({
      localizedDisplayName: "Canonical Apparel",
      localizedDescription: "Canonical description",
    });
  });

  it("localizes merchant-facing mapping names without using Shopify taxonomy labels as the primary source", () => {
    const mapping = {
      id: "mapping-shoes",
      conditionKey: "shoes",
      displayName: "Footwear",
      taxonomyCategoryName: "Shoes",
      translations: [
        { locale: "en", displayName: "Footwear" },
        { locale: "de", displayName: "Schuhe" },
      ],
    };

    expect(localizeStoreCategoryMapping(mapping, "de-DE")).toEqual({ localizedDisplayName: "Schuhe" });
    expect(localizeStoreCategoryMapping(mapping, "fr-FR")).toEqual({ localizedDisplayName: "Footwear" });
    expect(localizeStoreCategoryMapping({ ...mapping, translations: [] }, "fr-FR")).toEqual({
      localizedDisplayName: "Footwear",
    });
  });
});
