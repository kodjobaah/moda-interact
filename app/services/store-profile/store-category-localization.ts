import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { sourceCatalogues } from "@/i18n/catalogues.js";

const logger = createLogger({
  serviceName: "moda-interact",
  environment: process.env.NODE_ENV ?? "development",
});
const reportedMissingKeys = new Set<string>();
const catalogues = sourceCatalogues as Record<string, Record<string, unknown>>;

export function storeCategoryKey(slug: string, field: "displayName" | "description") {
  return `storeProfile.categories.${slug}.${field}`;
}

export function hasStoreCategoryLocalization(slug: string) {
  const english = catalogues.en;
  return ["displayName", "description"].every((field) =>
    typeof english?.[storeCategoryKey(slug, field as "displayName" | "description")] === "string",
  );
}

function catalogueFor(locale: string) {
  return catalogues[locale] ?? catalogues[locale.split("-")[0]] ?? catalogues.en;
}

function localizedValue(slug: string, field: "displayName" | "description", locale: string, fallback: string) {
  const key = storeCategoryKey(slug, field);
  const value = catalogueFor(locale)?.[key];
  if (typeof value === "string") return value;

  const reportKey = `${locale}:${key}`.slice(0, 192);
  if (reportedMissingKeys.size < 64 && !reportedMissingKeys.has(reportKey)) {
    reportedMissingKeys.add(reportKey);
    logger.warn("store_profile.category_translation_missing", {
      locale: locale.slice(0, 32),
      key: key.slice(0, 160),
    });
  }
  const english = catalogues.en?.[key];
  return typeof english === "string" ? english : fallback;
}

export function localizeStoreCategory(
  category: { slug: string; displayName: string; description: string },
  locale: string,
) {
  return {
    localizedDisplayName: localizedValue(category.slug, "displayName", locale, category.displayName),
    localizedDescription: localizedValue(category.slug, "description", locale, category.description),
  };
}