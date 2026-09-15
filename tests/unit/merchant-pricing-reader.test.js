import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_ADMIN_LOCALES } from "../../app/i18n/catalogues";
import { createMerchantI18n } from "../../app/utils/merchant-i18n";
import ptBR from "../../app/i18n/locales/pt-BR.json";
import ptPT from "../../app/i18n/locales/pt-PT.json";

const findMany = vi.fn();

vi.mock("../../app/db.server", () => ({
  default: { merchantPricingPlan: { findMany } },
}));

const { readActiveMerchantPricingCatalogue, resolveCurrentRecoveryCreditOffers } = await import("../../app/services/merchant-pricing/merchant-pricing.server");

function plan(overrides = {}) {
  return {
    shopifyPlanHandle: "free",
    displayName: "Free",
    planKind: "FREE",
    isActive: true,
    cataloguePosition: 0,
    featured: false,
    includedRecoveryCredits: 5,
    allowancePeriod: "LIFETIME",
    billingPeriod: "EVERY_30_DAYS",
    recurringAmountMinor: 0,
    currency: "GBP",
    translations: [{ locale: "en", merchantDescription: "A free plan" }],
    usageEvents: [],
    ...overrides,
  };
}

describe("readActiveMerchantPricingCatalogue", () => {
  beforeEach(() => findMany.mockReset());

  it("keeps the exact 20-locale registry and distinct regional/script variants", () => {
    expect(new Set(SUPPORTED_ADMIN_LOCALES)).toEqual(new Set([
      "cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko",
      "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
    ]));
    expect(createMerchantI18n({ locale: "en-GB" }).catalogueLocale).toBe("en");
    expect(createMerchantI18n({ locale: "pt-BR" }).catalogueLocale).toBe("pt-BR");
    expect(createMerchantI18n({ locale: "pt-PT" }).catalogueLocale).toBe("pt-PT");
    expect(createMerchantI18n({ locale: "zh-Hans" }).catalogueLocale).toBe("zh-Hans");
    expect(createMerchantI18n({ locale: "zh-Hant" }).catalogueLocale).toBe("zh-Hant");
    const genericPricingKeys = [
      "fixed", "graduated", "volume", "unavailable", "option",
      "creditsPerUnit", "maximumUnits", "tierRange", "amountPerUnit", "flatAmount",
    ];
    const englishPlaceholders = [
      "Fixed", "Graduated", "Volume", "Pricing is currently unavailable.",
      "Pricing option {number}", "credits per unit", "Maximum units", "Up to",
      "Amount per unit", "Flat amount",
    ];
    genericPricingKeys.forEach((key, index) => {
      expect(ptBR[`onboarding.pricing.${key}`]).not.toBe(englishPlaceholders[index]);
      expect(ptPT[`onboarding.pricing.${key}`]).not.toBe(englishPlaceholders[index]);
    });
    expect(ptBR).not.toEqual(ptPT);
  });

  it("queries active plans in catalogue order and returns the exact localized DTO", async () => {
    findMany.mockResolvedValue([plan(), plan({ shopifyPlanHandle: "paid", displayName: "Paid", cataloguePosition: 2, translations: [{ locale: "en", merchantDescription: "Localized paid plan" }] })]);

    await expect(readActiveMerchantPricingCatalogue({ locale: "en-GB" })).resolves.toMatchObject([
      { shopifyPlanHandle: "free", localizedDescription: "A free plan", cataloguePosition: 0 },
      { shopifyPlanHandle: "paid", localizedDescription: "Localized paid plan", cataloguePosition: 2 },
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true }, orderBy: { cataloguePosition: "asc" } }));
    expect(JSON.stringify(await readActiveMerchantPricingCatalogue({ locale: "en" }))).not.toContain("adminLabel");
  });

  it("requires the exact resolved locale and does not fall back to English", async () => {
    findMany.mockResolvedValue([plan({ translations: [] })]);
    await expect(readActiveMerchantPricingCatalogue({ locale: "pt-BR" })).rejects.toThrow(/^MERCHANT_PRICING_CATALOGUE_INVALID:/);
    expect(findMany.mock.calls[0][0].include.translations.where).toEqual({ locale: "pt-BR" });
  });

  it("supports an empty active catalogue", async () => {
    findMany.mockResolvedValue([]);
    await expect(readActiveMerchantPricingCatalogue({ locale: "en" })).resolves.toEqual([]);
  });

  it("fails closed for corrupt order and usage pricing", async () => {
    findMany.mockResolvedValue([plan({ cataloguePosition: 2 }), plan({ shopifyPlanHandle: "other", cataloguePosition: 1 })]);
    await expect(readActiveMerchantPricingCatalogue({ locale: "en" })).rejects.toThrow(/^MERCHANT_PRICING_CATALOGUE_INVALID:/);

    findMany.mockResolvedValue([plan({ usageEvents: [{ position: 0, eventHandle: "recovery", creditsGrantedPerUnit: 1, maximumUnitsPerBillingPeriod: null, pricingMode: "FIXED", currency: "GBP", fixedUnitAmountMinor: 100, tiers: [{ position: 0, upTo: null, amountPerUnitMinor: 100, flatAmountMinor: 0 }] }] })]);
    await expect(readActiveMerchantPricingCatalogue({ locale: "en" })).rejects.toThrow(/^MERCHANT_PRICING_CATALOGUE_INVALID:/);
  });

  it("fails closed when tier upper bounds are not strictly increasing", async () => {
    findMany.mockResolvedValue([plan({ usageEvents: [{
      position: 0,
      eventHandle: "recovery",
      creditsGrantedPerUnit: 1,
      maximumUnitsPerBillingPeriod: null,
      pricingMode: "GRADUATED",
      currency: "GBP",
      fixedUnitAmountMinor: null,
      tiers: [
        { position: 0, upTo: 10, amountPerUnitMinor: 100, flatAmountMinor: 0 },
        { position: 1, upTo: 10, amountPerUnitMinor: 50, flatAmountMinor: 0 },
        { position: 2, upTo: null, amountPerUnitMinor: 25, flatAmountMinor: 0 },
      ],
    }] })]);

    await expect(readActiveMerchantPricingCatalogue({ locale: "en" })).rejects.toThrow(/^MERCHANT_PRICING_CATALOGUE_INVALID:/);
  });

  it.each(["GRADUATED", "VOLUME"])("fails closed when %s pricing has a fixed amount", async (pricingMode) => {
    findMany.mockResolvedValue([plan({ usageEvents: [{
      position: 0,
      eventHandle: "recovery",
      creditsGrantedPerUnit: 1,
      maximumUnitsPerBillingPeriod: null,
      pricingMode,
      currency: "GBP",
      fixedUnitAmountMinor: 100,
      tiers: [{ position: 0, upTo: null, amountPerUnitMinor: 100, flatAmountMinor: 0 }],
    }] })]);

    await expect(readActiveMerchantPricingCatalogue({ locale: "en" })).rejects.toThrow(/^MERCHANT_PRICING_CATALOGUE_INVALID:/);
  });
});

describe("resolveCurrentRecoveryCreditOffers", () => {
  const providerItem = (handle, amount = "4.00") => ({
    handle,
    price: { kind: "TIERED", active: false, currency: "USD", tiersMode: "VOLUME", tiers: [{ upTo: null, amountPerUnit: amount, amount }] },
    usage: { quantity: 2, costAmount: amount, costCurrency: "USD" },
  });
  const providerSubscription = (usageItems, planHandle = "growth") => ({
    status: "ACTIVE",
    planHandle,
    usageItems,
  });
  const plan = (shopifyPlanHandle = "growth", usageEvents = []) => ({ shopifyPlanHandle, isActive: false, usageEvents });

  it("intersects exact handles in position order and uses live provider values", () => {
    const result = resolveCurrentRecoveryCreditOffers({
      providerSubscription: providerSubscription([providerItem("second", "8.00"), providerItem("first")]),
      merchantPricingPlan: plan("growth", [
        { position: 1, eventHandle: "second", creditsGrantedPerUnit: 40 },
        { position: 0, eventHandle: "first", creditsGrantedPerUnit: 12 },
      ]),
    });
    expect(result.offers).toEqual([
      expect.objectContaining({ eventHandle: "first", cataloguePosition: 0, creditsGranted: 12, providerPrice: expect.objectContaining({ active: false }), providerUsage: expect.objectContaining({ costAmount: "4.00" }) }),
      expect.objectContaining({ eventHandle: "second", cataloguePosition: 1, creditsGranted: 40, providerPrice: expect.objectContaining({ tiers: [{ amountPerUnit: "8.00", amount: "8.00", upTo: null }] }) }),
    ]);
  });

  it("omits missing events, records unknown provider meters, and never crosses plan handles", () => {
    const result = resolveCurrentRecoveryCreditOffers({
      providerSubscription: providerSubscription([providerItem("known"), providerItem("unknown")]),
      merchantPricingPlan: plan("growth", [{ position: 0, eventHandle: "known", creditsGrantedPerUnit: 5 }]),
    });
    expect(result.offers).toHaveLength(1);
    expect(result.diagnostics).toEqual([{ code: "UNKNOWN_PROVIDER_METER", handle: "unknown" }]);
    expect(resolveCurrentRecoveryCreditOffers({
      providerSubscription: providerSubscription([providerItem("known")], "other-plan"),
      merchantPricingPlan: plan("growth", [{ position: 0, eventHandle: "known", creditsGrantedPerUnit: 5 }]),
    })).toEqual({ offers: [], diagnostics: [] });
  });

  it.each([[[]], [[{ position: 0, eventHandle: "missing", creditsGrantedPerUnit: 5 }]]])("returns an empty valid intersection for %j", (usageEvents) => {
    expect(resolveCurrentRecoveryCreditOffers({
      providerSubscription: providerSubscription([]),
      merchantPricingPlan: plan("growth", usageEvents),
    }).offers).toEqual([]);
  });
});
