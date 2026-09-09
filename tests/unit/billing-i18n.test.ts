import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CATALOGUE_KEYS, catalogues } from "../../app/i18n/catalogues";
import { createMerchantI18n } from "../../app/utils/merchant-i18n";

const localeDirectory = new URL("../../app/i18n/locales/", import.meta.url);

describe("ARCH-007 billing translations", () => {
  const taskKeys = [
    "billing.purchasedRecoveryCredits",
    "billing.recoveryCreditPackDescription",
    "billing.recoveryCreditPackShopifyMeter",
    "billing.buyRecoveryCreditPack",
    "billing.recoveryCreditPurchasePending",
  ];

  it("defines every billing key in every locale catalogue", async () => {
    const localeFiles = (await readdir(localeDirectory)).filter((file) => file.endsWith(".json"));
    const english = JSON.parse(await readFile(new URL("en.json", localeDirectory), "utf8"));
    const billingKeys = Object.keys(english).filter((key) => key.startsWith("billing."));

    expect(billingKeys.length).toBeGreaterThan(0);

    for (const localeFile of localeFiles) {
      const locale = JSON.parse(await readFile(new URL(localeFile, localeDirectory), "utf8"));
      expect(Object.keys(locale).filter((key) => key.startsWith("billing."))).toEqual(
        expect.arrayContaining(billingKeys),
      );
    }
  });

  it("preserves ICU placeholders and resolves every task key through the merchant runtime", () => {
    const english = catalogues.en as Record<string, string>;
    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]).sort();
    const i18n = createMerchantI18n({ locale: "en", fallbackLocale: "en", timeZone: "UTC" });

    expect(CATALOGUE_KEYS).toEqual(expect.arrayContaining(taskKeys));
    for (const locale of Object.keys(catalogues)) {
      const catalogue = catalogues[locale as keyof typeof catalogues] as Record<string, string>;
      for (const key of taskKeys) {
        expect(placeholders(catalogue[key])).toEqual(placeholders(english[key]));
        expect(i18n.t(key, {
          granted: 100,
          committed: 20,
          reserved: 5,
          available: 75,
          quantity: 100,
        })).toEqual(expect.any(String));
      }
    }
  });

  it("keeps task-visible billing copy in the merchant i18n path", async () => {
    const source = await readFile(new URL("../../app/routes/app.billing.tsx", import.meta.url), "utf8");

    expect(source).toContain('i18n.t("billing.purchasedRecoveryCredits"');
    expect(source).toContain('i18n.t("billing.recoveryCreditPackDescription"');
    expect(source).toContain('i18n.t("billing.recoveryCreditPackShopifyMeter"');
    expect(source).toContain('"billing.buyRecoveryCreditPack"');
    expect(source).toContain('i18n.t("billing.recoveryCreditPurchasePending"');
    expect(source).not.toContain("Purchased recovery credits:");
    expect(source).not.toContain("Buy recovery-credit pack");
  });
});