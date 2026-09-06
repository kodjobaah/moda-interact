// @ts-nocheck

import {
  createInternationalizationRuntime,
  normalizeTimeZone,
  validateIcuCatalogue,
} from "@modainteract/moda-interact-shared/internationalization";

import {
  CATALOGUE_KEYS,
  catalogues,
  sourceCatalogues,
  SUPPORTED_ADMIN_LOCALES,
} from "../i18n/catalogues.js";

const DEFAULT_LOCALE = "en-GB";
const DEFAULT_TIME_ZONE = "UTC";

export { CATALOGUE_KEYS, catalogues, sourceCatalogues, SUPPORTED_ADMIN_LOCALES };

function resolveLocale(locale) {
  if (typeof locale !== "string" || !locale.trim()) return DEFAULT_LOCALE;
  try {
    return new Intl.Locale(locale.trim()).toString();
  } catch {
    return DEFAULT_LOCALE;
  }
}

function isValidLocale(locale) {
  if (typeof locale !== "string" || !locale.trim()) return false;
  try {
    new Intl.Locale(locale.trim());
    return true;
  } catch {
    return false;
  }
}

function resolveTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim()) return DEFAULT_TIME_ZONE;
  try {
    return normalizeTimeZone(timeZone);
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function resolveCatalogueLocale(locale, fallbackLocale) {
  if (catalogues[locale]) return locale;
  const baseLocale = locale.split("-")[0].toLowerCase();
  if (catalogues[baseLocale]) return baseLocale;
  const fallback = resolveLocale(fallbackLocale);
  if (catalogues[fallback]) return fallback;
  if (catalogues[fallback.split("-")[0].toLowerCase()]) return fallback.split("-")[0].toLowerCase();
  return "en";
}

export function createMerchantI18n({ locale, timeZone, fallbackLocale } = {}) {
  const resolvedLocale = resolveLocale(locale);
  const catalogueLocale = resolveCatalogueLocale(resolvedLocale, fallbackLocale);
  validateIcuCatalogue(catalogues[catalogueLocale], CATALOGUE_KEYS, { locale: catalogueLocale });
  const runtime = createInternationalizationRuntime({
    locale: resolvedLocale,
    catalogue: catalogues[catalogueLocale],
    timeZone: resolveTimeZone(timeZone),
  });

  return {
    ...runtime,
    catalogueLocale,
    formatMoney: (value, currency, options = {}) => {
      if (typeof currency !== "string" || !currency.trim()) throw new Error("A currency is required to format money");
      return runtime.formatMoney(value, currency, options);
    },
    formatDateTime: (value, options = {}) => runtime.formatDateTime(value, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...options,
    }),
    formatDate: (value, options = {}) => runtime.formatDateTime(value, {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...options,
    }),
    formatTime: (value, options = {}) => runtime.formatDateTime(value, {
      hour: "2-digit",
      minute: "2-digit",
      ...options,
    }),
  };
}

export function merchantUiContext(settings, authenticatedLocale) {
  const merchantLocale = settings?.defaultLanguageTag;
  const sessionLocale = typeof authenticatedLocale === "string"
    ? authenticatedLocale
    : authenticatedLocale?.locale;
  const selectedLocale = isValidLocale(sessionLocale)
    ? sessionLocale
    : isValidLocale(merchantLocale) ? merchantLocale : DEFAULT_LOCALE;

  return {
    locale: resolveLocale(selectedLocale),
    timeZone: resolveTimeZone(settings?.defaultTimeZone),
    fallbackLocale: resolveLocale(settings?.defaultLanguageTag || DEFAULT_LOCALE),
  };
}

export { DEFAULT_LOCALE, DEFAULT_TIME_ZONE };
