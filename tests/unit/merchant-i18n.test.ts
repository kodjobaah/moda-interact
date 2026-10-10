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

  it("translates authenticated support copy and preserves manifest placeholders", () => {
    const french = createMerchantI18n({ locale: "fr-FR" });

    expect(french.t("common.logoAlt")).toBe("Logo de Moda Interact");
    expect(french.t("support.thread")).toBe("Fil d’assistance");
    expect(french.t("support.page", { page: 2, totalPages: 4 })).toBe("Page 2 sur 4");
    expect(french.t("support.messageLengthError", { max: 500 })).toBe("Le message doit contenir entre 1 et 500 graphèmes.");
    expect(rawCatalogues.fr["support.messageLengthError"]).toContain("{max}");
    expect(rawCatalogues.fr["support.modaSupport"]).toBe("Moda Support");
    expect(rawCatalogues["pt-BR"]["support.contactHeading"]).not.toBe(rawCatalogues["pt-PT"]["support.contactHeading"]);
    expect(rawCatalogues["zh-Hans"]["common.logoAlt"]).not.toBe(rawCatalogues["zh-Hant"]["common.logoAlt"]);
  });

  it("keeps the exact English source strings from the support manifest", () => {
    expect(rawCatalogues.en).toMatchObject({
      "common.logoAlt": "Moda Interact logo",
      "support.thread": "Support thread",
      "support.empty": "No messages yet.",
      "support.paginationLabel": "Support thread pages",
      "support.previous": "Previous",
      "support.next": "Next",
      "support.page": "Page {page} of {totalPages}",
      "support.contactHeading": "Contact Moda Support",
      "support.messageLabel": "Message",
      "support.messageLengthError": "Message must contain between 1 and {max} graphemes.",
      "support.sending": "Sending...",
      "support.send": "Send",
      "support.you": "You",
      "support.system": "System",
      "support.modaSupport": "Moda Support",
      "support.translationUnavailable": "Translation unavailable. Please try again later.",
      "support.translationProcessing": "Translation is processing.",
      "support.viewTranslation": "View translation",
      "support.viewOriginal": "View original",
      "support.sendFailed": "Unable to send message. Please try again.",
      "support.unsupportedAction": "That support action is not available.",
    });
  });

  it("translates newly covered Recovery Settings and Merchant Knowledge copy", () => {
    const french = createMerchantI18n({ locale: "fr-FR", timeZone: "Europe/Paris" });

    expect(french.t("recoverySettings.context.title")).toBe("Contexte de la boutique et de l’assistant");
    expect(french.t("merchantKnowledge.title")).toBe("Connaissances de la boutique");
    expect(french.t("merchantKnowledge.sourceCount", { configured: 2, max: 5 })).toBe("2 sources configurées sur 5");
    expect(french.t("merchantKnowledge.lastProcessed", { date: "10 oct. 14:30" })).toBe("Dernier traitement : 10 oct. 14:30");
    expect(french.t("merchantFeatures.features.product_search.name")).toBe("Recherche de produits");
    expect(french.t("reinstalling.retry")).toBe("Réessayer");
    expect(rawCatalogues.fr["storeProfile.description"]).not.toContain("publication");
    expect(rawCatalogues.fr["storeProfile.pendingPublication"]).toBe("En attente de la fin de la configuration");
  });

  it("keeps Czech, Danish, and Finnish promotion copy semantic rather than English placeholders", () => {
    for (const locale of ["cs", "da", "fi"] as const) {
      for (const key of [
        "promotions.page.title",
        "promotions.page.description",
        "promotions.action.select",
        "promotions.error.activeSelected",
      ]) {
        expect(rawCatalogues[locale][key]).not.toBe(rawCatalogues.en[key]);
      }
      for (const key of ["promotions.history.title", "promotions.history.empty", "promotions.status.reopened"]) {
        expect(rawCatalogues[locale][key]).not.toBe(rawCatalogues.en[key]);
      }
    }
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

  it("uses canonical unavailable labels without changing locale catalogues", () => {
    const i18n = createMerchantI18n({ locale: "en-GB" });
    expect(i18n.t("common.unavailable")).toBe("Unavailable");
    expect(i18n.t("pending.unavailableMessage")).toBeTruthy();
    expect(pendingRecoveriesSource).not.toContain('i18n.t("pending.unavailable")');
    expect(pendingRecoveriesSource).toContain('i18n.t("pending.unavailableMessage")');
  });
});
