import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const extensionRoot = join(process.cwd(), "extensions/moda-whatsapp-consent");
const localesRoot = join(extensionRoot, "locales");
const schemaKeys = [
  ["blocks", "cart_consent", "name"],
  ["blocks", "cart_drawer_consent", "name"],
  ["settings", "app_proxy_root", "label"],
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const lookup = (source, keys) =>
  keys.reduce((node, key) => node?.[key], source);

const readBlockSchema = (file) => {
  const liquid = readFileSync(join(extensionRoot, "blocks", file), "utf8");
  const match = liquid.match(/{% schema %}\s*([\s\S]*?)\s*{% endschema %}/);
  if (!match) throw new Error(`Missing schema: ${file}`);
  return JSON.parse(match[1]);
};

describe("WhatsApp consent theme-editor schema internationalisation", () => {
  it("uses locale references for cart and drawer names and settings labels", () => {
    for (const [file, nameKey] of [
      ["cart-consent.liquid", "cart_consent"],
      ["cart-drawer-consent.liquid", "cart_drawer_consent"],
    ]) {
      const schema = readBlockSchema(file);
      expect(schema.name).toBe(`t:blocks.${nameKey}.name`);
      expect(
        schema.settings.find(({ id }) => id === "app_proxy_root")?.label,
      ).toBe("t:settings.app_proxy_root.label");
    }
  });

  it("provides all three merchant-facing labels in every storefront locale", () => {
    const storefrontLocales = readdirSync(localesRoot)
      .filter(
        (file) => file.endsWith(".json") && !file.endsWith(".schema.json"),
      )
      .map((file) => file.replace(/\.json$/, ""))
      .sort();
    const schemaLocales = readdirSync(localesRoot)
      .filter((file) => file.endsWith(".schema.json"))
      .map((file) => file.replace(/\.schema\.json$/, ""))
      .sort();
    expect(storefrontLocales).toHaveLength(20);
    expect(schemaLocales).toEqual(storefrontLocales);
    for (const locale of schemaLocales) {
      const schema = readJson(join(localesRoot, `${locale}.schema.json`));
      for (const key of schemaKeys) {
        const value = lookup(schema, key);
        expect(typeof value, `${locale}: ${key.join(".")}`).toBe("string");
        expect(
          value.trim().length,
          `${locale}: ${key.join(".")}`,
        ).toBeGreaterThan(0);
      }
      expect(lookup(schema, schemaKeys[0]).length).toBeLessThanOrEqual(25);
      expect(lookup(schema, schemaKeys[1]).length).toBeLessThanOrEqual(25);
      // Merchant instructions must refer to the localized theme-editor setting name.
      const merchantLocale = locale === "en.default" ? "en" : locale;
      const merchantCatalogue = readJson(
        join(process.cwd(), "app/i18n/locales", `${merchantLocale}.json`),
      );
      const guidance =
        merchantCatalogue["recoverySettings.whatsappConsent.proxyBody"];
      expect(guidance).toContain(lookup(schema, schemaKeys[2]));
    }
  });
});
