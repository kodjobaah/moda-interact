import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const locales = ["cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant"];
const localeDirectory = new URL("../../app/i18n/locales/", import.meta.url);
const catalogueSource = new URL("../../app/i18n/catalogues.js", import.meta.url);

const placeholderNames = (value: string) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();

describe("purchased credit source translations", () => {
  it("keeps all 20 raw locale namespaces exactly aligned with English", async () => {
    const english = JSON.parse(await readFile(new URL("en.json", localeDirectory), "utf8"));
    const englishKeys = Object.keys(english).filter((key) => key.startsWith("billingPurchases.")).sort();
    expect(englishKeys.length).toBeGreaterThan(0);

    for (const locale of locales) {
      const catalogue = JSON.parse(await readFile(new URL(`${locale}.json`, localeDirectory), "utf8"));
      const keys = Object.keys(catalogue).filter((key) => key.startsWith("billingPurchases.")).sort();
      expect(keys).toEqual(englishKeys);
      expect(keys).toHaveLength(englishKeys.length);
      for (const key of englishKeys) {
        expect(catalogue[key]).toEqual(expect.any(String));
        expect(catalogue[key].length).toBeGreaterThan(0);
        expect(placeholderNames(catalogue[key])).toEqual(placeholderNames(english[key]));
      }
    }
  });

  it("does not mutate locale catalogues with an English fallback loop", async () => {
    const source = await readFile(catalogueSource, "utf8");
    expect(source).not.toContain("Object.entries(enCatalogue)");
    expect(source).not.toContain("if (!(key in catalogue))");
    expect(source).not.toContain("catalogue[key] = value");
  });
});