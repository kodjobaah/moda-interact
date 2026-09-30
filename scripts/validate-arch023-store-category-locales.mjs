import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const ARCH023_LOCALES = [
  "zh-Hans", "zh-Hant", "cs", "da", "nl", "en", "fi", "fr", "de", "it",
  "ja", "ko", "nb", "pl", "pt-BR", "pt-PT", "es", "sv", "th", "tr",
];
const readCatalogue = (locale) => JSON.parse(readFileSync(`${root}/app/i18n/locales/${locale}.json`, "utf8"));

export function validateStoreCategoryLocales(english, catalogues, locales = ARCH023_LOCALES) {
  const categoryFields = new Map();
  for (const key of Object.keys(english)) {
    const match = /^storeProfile\.categories\.([a-z0-9]+(?:-[a-z0-9]+)*)\.(displayName|description)$/.exec(key);
    if (!match) continue;
    const fields = categoryFields.get(match[1]) ?? new Set();
    fields.add(match[2]);
    categoryFields.set(match[1], fields);
  }

  assert.ok(categoryFields.size > 0, "English catalogue must define at least one Store Category slug");
  const requiredKeys = [
    ...[...categoryFields].flatMap(([slug, fields]) => {
      assert.deepEqual([...fields].sort(), ["description", "displayName"], `English category ${slug} must define both localization keys`);
      return [`storeProfile.categories.${slug}.displayName`, `storeProfile.categories.${slug}.description`];
    }),
    ...[
      "COMPANY_INFORMATION", "CUSTOMER_SUPPORT", "POLICIES", "FAQ", "PRODUCT_INFORMATION", "SHIPPING_AND_DELIVERY", "PRICING",
    ].map((key) => `merchantKnowledge.purposes.${key}.label`),
    ...["WEB_PAGE", "CSV", "XLSX"].map((key) => `merchantKnowledge.dataFormats.${key}.label`),
  ];

  for (const key of requiredKeys) assert.equal(typeof english[key], "string", `English catalogue is missing ${key}`);
  for (const locale of locales) {
    const catalogue = catalogues[locale];
    assert.ok(catalogue, `Missing locale catalogue ${locale}`);
    for (const key of requiredKeys) assert.equal(typeof catalogue[key], "string", `${locale} catalogue is missing ${key}`);
  }
  return requiredKeys;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const catalogues = Object.fromEntries(ARCH023_LOCALES.map((locale) => [locale, readCatalogue(locale)]));
  const requiredKeys = validateStoreCategoryLocales(readCatalogue("en"), catalogues);
  console.log(`ARCH-023 Store Category and Merchant Knowledge locale keys passed (${ARCH023_LOCALES.length} locales, ${requiredKeys.length} keys).`);
}