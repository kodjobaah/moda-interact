import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  CATALOGUE_KEYS,
  SUPPORTED_ADMIN_LOCALES,
  catalogues,
  createMerchantI18n,
  merchantUiContext,
  sourceCatalogues,
} from "../../app/utils/merchant-i18n";
import { validateIcuCatalogue } from "@modainteract/moda-interact-shared/internationalization";
import { groupRecoveriesByCustomer } from "../../app/components/dashboard/RecoveryChart";

const rawCatalogues = sourceCatalogues as Record<string, Record<string, string>>;
const registeredCatalogues = catalogues as Record<string, Record<string, string>>;
const pendingRecoveriesSource = await readFile(
  new URL("../../app/components/dashboard/PendingRecoveries.jsx", import.meta.url),
  "utf8",
);

describe("merchant UI internationalisation", () => {
  it("falls back to the default locale and catalogue for invalid values", () => {
    const i18n = createMerchantI18n({ locale: "en_US", timeZone: "invalid/zone" });

    expect(i18n.locale).toBe("en-GB");
    expect(i18n.timeZone).toBe("UTC");
    expect(i18n.t("dashboard.performance")).toBe("Performance");
  });

  it("translates stable catalogue keys and interpolates values", () => {
    const i18n = createMerchantI18n({ locale: "fr-FR", timeZone: "Europe/Paris" });

    expect(i18n.t("dashboard.performance")).toBe("Performances");
    expect(i18n.t("pending.page", { page: 2, totalPages: 4 })).toBe("Page 2 sur 4");
    expect(createMerchantI18n({ locale: "en-GB" }).t("usage.actions", { quantity: 1 })).toBe("1 action");
    expect(createMerchantI18n({ locale: "en-GB" }).t("usage.actions", { quantity: 2 })).toBe("2 actions");
    expect(i18n.t("usage.actions", { quantity: 2 })).toBe("2 actions");
  });

  it("has every required Shopify Admin catalogue and canonical key", () => {
    for (const locale of SUPPORTED_ADMIN_LOCALES) {
      expect(rawCatalogues[locale]).toBeDefined();
      expect(Object.keys(rawCatalogues[locale]).sort()).toEqual([...CATALOGUE_KEYS].sort());
      expect(registeredCatalogues[locale]).toBe(rawCatalogues[locale]);
      expect(() => validateIcuCatalogue(rawCatalogues[locale], CATALOGUE_KEYS, { locale })).not.toThrow();
    }
  });

  it("keeps representative translations in each supplied locale catalogue", () => {
    expect(rawCatalogues.fr["dashboard.performance"]).not.toBe(rawCatalogues.en["dashboard.performance"]);
    expect(rawCatalogues.fr["pending.status"]).not.toBe(rawCatalogues.en["pending.status"]);
    expect(rawCatalogues.fr["usage.range"]).not.toBe(rawCatalogues.en["usage.range"]);
    expect(rawCatalogues.ja["dashboard.performance"]).not.toBe(rawCatalogues.en["dashboard.performance"]);
    expect(rawCatalogues.ja["chart.customerInteractions"]).not.toBe(rawCatalogues.en["chart.customerInteractions"]);
    expect(rawCatalogues["zh-Hans"]["onboarding.heading"]).not.toBe(rawCatalogues.en["onboarding.heading"]);
    expect(rawCatalogues["zh-Hant"]["chart.recoveryDetails"]).not.toBe(rawCatalogues.en["chart.recoveryDetails"]);
  });

  it("retains regional formatting while resolving compatible catalogues", () => {
    expect(createMerchantI18n({ locale: "fr-CA" }).locale).toBe("fr-CA");
    expect(createMerchantI18n({ locale: "fr-CA" }).t("pending.title")).toBe("Récupérations en attente");
    expect(createMerchantI18n({ locale: "es-MX" }).t("pending.title")).toBe("Recuperaciones pendientes");
    expect(createMerchantI18n({ locale: "pt-BR" }).t("usage.title")).not.toBe(createMerchantI18n({ locale: "pt-PT" }).t("usage.title"));
    expect(createMerchantI18n({ locale: "zh-Hans" }).t("usage.title")).not.toBe(createMerchantI18n({ locale: "zh-Hant" }).t("usage.title"));
    expect(createMerchantI18n({ locale: "zz-ZZ", fallbackLocale: "fr" }).t("pending.title")).toBe("Récupérations en attente");
    expect(createMerchantI18n({ locale: "fr" }).t("chart.close")).toBe("Fermer les interactions client");
    expect(createMerchantI18n({ locale: "ja" }).t("pending.status")).not.toBe("Status");
    expect(createMerchantI18n({ locale: "zh-Hans" }).t("onboarding.heading")).not.toBe("Recover more abandoned checkouts");
    expect(createMerchantI18n({ locale: "zh-Hant" }).t("chart.recoveryDetails")).not.toBe("Recovery details");
  });

  it("uses raw quantities and locale plural categories", () => {
    const czech = createMerchantI18n({ locale: "cs" });

    expect(czech.t("usage.actions", { quantity: 1 })).toBe("1 akce");
    expect(czech.t("usage.actions", { quantity: 2 })).toBe("2 akce");
    expect(czech.t("usage.actions", { quantity: 5 })).toBe("5 akcí");
    expect(czech.t("usage.actions", { quantity: 1000 })).toBe(`${czech.formatNumber(1000)} akcí`);
  });

  it("uses authenticated locale before merchant default and keeps timezone independent", () => {
    expect(merchantUiContext({ defaultLanguageTag: "de-DE", defaultTimeZone: "Europe/Berlin" }, "fr-CA")).toEqual({ locale: "fr-CA", timeZone: "Europe/Berlin", fallbackLocale: "de-DE" });
    expect(merchantUiContext({ defaultLanguageTag: "de-DE", defaultTimeZone: "Europe/Berlin" }, "en_US")).toEqual({ locale: "de-DE", timeZone: "Europe/Berlin", fallbackLocale: "de-DE" });
    expect(merchantUiContext({ defaultLanguageTag: "de-DE", defaultTimeZone: "Europe/Berlin" }, undefined).locale).toBe("de-DE");
  });

  it("requires the commerce currency for money formatting", () => {
    const i18n = createMerchantI18n({ locale: "en-GB" });

    expect(i18n.formatMoney(12.5, "GBP")).toContain("12.50");
    expect(() => i18n.formatMoney(12.5)).toThrow("A currency is required");
  });

  it("formats stored UTC instants in the merchant timezone", () => {
    const i18n = createMerchantI18n({ locale: "en-GB", timeZone: "America/New_York" });
    const value = "2026-01-15T05:30:00.000Z";

    expect(i18n.formatDateTime(value)).toContain("00:30");
  });

  it("exposes RTL direction without changing customer or checkout context", () => {
    const settings = {
      defaultLanguageTag: "ar-EG",
      defaultTimeZone: "Africa/Cairo",
      defaultCountryCode: "EG",
    };
    const conversation = { languageTag: "fr-FR" };
    const template = { language: "fr" };
    const recovery = { currency: "EUR" };
    const context = merchantUiContext(settings, "ar-EG");
    const i18n = createMerchantI18n(context);

    expect(context).toEqual({ locale: "ar-EG", timeZone: "Africa/Cairo", fallbackLocale: "ar-EG" });
    expect(i18n.direction).toBe("rtl");
    expect({ conversation, template, recovery }).toEqual({ conversation: { languageTag: "fr-FR" }, template: { language: "fr" }, recovery: { currency: "EUR" } });
    expect(i18n.direction).not.toBe("auto");
  });

  it("keeps customer recovery totals separate by currency and never invents GBP", () => {
    const [customer] = groupRecoveriesByCustomer([
      { id: "gbp", customer: { id: "customer-1" }, totalPrice: 10, currency: "GBP", messageCount: 0 },
      { id: "eur", customer: { id: "customer-1" }, totalPrice: 20, currency: "EUR", messageCount: 0 },
      { id: "missing", customer: { id: "customer-1" }, totalPrice: 30, currency: null, messageCount: 0 },
    ]);

    expect(customer.totalsByCurrency).toEqual({ GBP: 10, EUR: 20 });
    expect(customer.totalsByCurrency.GBP).not.toBe(60);
    expect(customer.totalsByCurrency.USD).toBeUndefined();
    expect(createMerchantI18n({ locale: "fr-FR" }).formatMoney(12.5, "USD")).toContain("12,50");
  });

  it("uses canonical unavailable labels without changing locale catalogues", () => {
    const i18n = createMerchantI18n({ locale: "en-GB" });
    expect(i18n.t("common.unavailable")).toBe("Unavailable");
    expect(i18n.t("pending.unavailableMessage")).toBeTruthy();
    expect(pendingRecoveriesSource).not.toContain('i18n.t("pending.unavailable")');
    expect(pendingRecoveriesSource).toContain('i18n.t("pending.unavailableMessage")');
  });
});
