import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CATALOGUE_KEYS, catalogues } from "../../app/i18n/catalogues";
import { createMerchantI18n } from "../../app/utils/merchant-i18n";

const localeDirectory = new URL("../../app/i18n/locales/", import.meta.url);

describe("ARCH-007 billing translations", () => {
  const auditedLegacyBillingKeys = [
    "billing.title",
    "billing.currentPlan",
    "billing.status",
    "billing.freeAllowance",
    "billing.lifetimeFreeAllowance",
    "billing.paidIncludedAllowance",
    "billing.paidUsage",
    "billing.currentPeriod",
    "billing.trialEnds",
    "billing.cancelAtPeriodEnd",
    "billing.viewPlans",
    "billing.upgradePlan",
    "billing.changePlan",
    "billing.unknownPlan",
    "billing.configurationUnavailable",
    "billing.configurationUnavailableDescription",
    "billingCommerce.promotionalCredits",
  ];
  const taskKeys = [
    "billing.lifetimeFreeAllowance",
    "billing.paidIncludedAllowance",
    "billing.purchasedRecoveryCredits",
    "billing.recoveryCreditPackDescription",
    "billing.recoveryCreditPackShopifyMeter",
    "billing.buyRecoveryCreditPack",
    "billing.recoveryCreditPurchasePending",
    "billing.paidCycleDraining",
    "billing.paidCycleReconciling",
    "billing.freeCycleDraining",
    "billing.freeCycleReconciling",
    "billing.contractRequiredDescription",
    "billing.postContractDescription",
    "billing.postContractExhaustedDescription",
    "billing.noActiveSubscription",
    "billing.subscribeAgain",
  ];
  const localizedPhaseKeys = new Set([
    "billing.paidCycleDraining",
    "billing.paidCycleReconciling",
    "billing.freeCycleDraining",
    "billing.freeCycleReconciling",
    "billing.contractRequiredDescription",
    "billing.postContractDescription",
    "billing.postContractExhaustedDescription",
    "billing.noActiveSubscription",
    "billing.subscribeAgain",
  ]);

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

  it("does not regress the audited legacy billing block to English placeholders", () => {
    const english = catalogues.en as Record<string, string>;

    for (const [locale, rawCatalogue] of Object.entries(catalogues)) {
      if (locale === "en") continue;
      const catalogue = rawCatalogue as Record<string, string>;
      for (const key of auditedLegacyBillingKeys) {
        expect(catalogue[key], `${locale}:${key}`).not.toBe(english[key]);
      }
    }

    for (const locale of ["pt-BR", "pt-PT"] as const) {
      const catalogue = catalogues[locale] as Record<string, string>;
      expect(catalogue["onboarding.topups.description"]).not.toBe(english["onboarding.topups.description"]);
      expect(catalogue["onboarding.cta.description"]).not.toBe(english["onboarding.cta.description"]);
    }
  });

  it("preserves ICU placeholders and resolves every task key through the merchant runtime", () => {
    const english = catalogues.en as Record<string, string>;
    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]).sort();

    expect(CATALOGUE_KEYS).toEqual(expect.arrayContaining(taskKeys));
    for (const locale of Object.keys(catalogues)) {
      const catalogue = catalogues[locale as keyof typeof catalogues] as Record<string, string>;
      const i18n = createMerchantI18n({ locale, fallbackLocale: "en", timeZone: "UTC" });
      expect(i18n.catalogueLocale).toBe(locale);
      for (const key of taskKeys) {
        expect(placeholders(catalogue[key])).toEqual(placeholders(english[key]));
        expect(catalogue[key]).toBeTruthy();
        if (locale !== "en" && localizedPhaseKeys.has(key)) {
          expect(catalogue[key]).not.toBe(english[key]);
        }
        expect(i18n.t(key, {
          granted: 100,
          committed: 20,
          reserved: 5,
          refunding: 10,
          available: 75,
          quantity: 100,
          remaining: 75,
          allowance: 100,
        })).toEqual(expect.any(String));
      }
    }
  });

});