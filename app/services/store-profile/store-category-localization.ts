import { createLogger } from "@modainteract/moda-interact-shared/logging";
import {
  resolveModaConfigurationLocale,
  type ModaSupportedLanguageTag,
} from "@modainteract/moda-interact-shared/internationalization";

const logger = createLogger({
  serviceName: "moda-interact",
  environment: process.env.NODE_ENV ?? "development",
});

const reportedMissingTranslations = new Set<string>();

type CategoryTranslation = {
  locale: string;
  displayName: string;
  description: string;
};

type MappingTranslation = {
  locale: string;
  displayName: string;
};

function reportMissingTranslation({
  entity,
  entityId,
  locale,
}: {
  entity: "category" | "mapping";
  entityId: string;
  locale: string;
}) {
  const reportKey = `${entity}:${entityId}:${locale}`.slice(0, 192);
  if (reportedMissingTranslations.size >= 64 || reportedMissingTranslations.has(reportKey)) return;
  reportedMissingTranslations.add(reportKey);
  logger.warn("store_profile.translation_missing", {
    entity,
    entityId: entityId.slice(0, 128),
    locale: locale.slice(0, 32),
  });
}

export function resolveStoreCategoryLocale(locale: string | null | undefined): ModaSupportedLanguageTag {
  return resolveModaConfigurationLocale(locale);
}

export function storeCategoryTranslationLocales(locale: string | null | undefined) {
  const resolved = resolveStoreCategoryLocale(locale);
  return resolved === "en" ? ["en"] : [resolved, "en"];
}

function findTranslation<T extends { locale: string }>(translations: T[] | null | undefined, locale: string) {
  return translations?.find((translation) => translation.locale === locale) ?? null;
}

export function localizeStoreCategory(
  category: {
    id: string;
    displayName: string;
    description: string;
    translations?: CategoryTranslation[] | null;
  },
  locale: string | null | undefined,
) {
  const resolvedLocale = resolveStoreCategoryLocale(locale);
  const localized = findTranslation(category.translations, resolvedLocale);
  const english = findTranslation(category.translations, "en");

  if (!localized) {
    reportMissingTranslation({ entity: "category", entityId: category.id, locale: resolvedLocale });
  }

  return {
    localizedDisplayName: localized?.displayName ?? english?.displayName ?? category.displayName,
    localizedDescription: localized?.description ?? english?.description ?? category.description,
  };
}

export function localizeStoreCategoryMapping(
  mapping: {
    id: string;
    conditionKey: string | null;
    displayName: string | null;
    taxonomyCategoryName?: string | null;
    translations?: MappingTranslation[] | null;
  },
  locale: string | null | undefined,
) {
  const resolvedLocale = resolveStoreCategoryLocale(locale);
  const localized = findTranslation(mapping.translations, resolvedLocale);
  const english = findTranslation(mapping.translations, "en");

  if (!localized) {
    reportMissingTranslation({ entity: "mapping", entityId: mapping.id, locale: resolvedLocale });
  }

  return {
    localizedDisplayName:
      localized?.displayName
      ?? english?.displayName
      ?? mapping.displayName
      ?? mapping.taxonomyCategoryName
      ?? mapping.conditionKey
      ?? "",
  };
}
