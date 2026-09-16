// @ts-nocheck

import db from "@/db.server";
import { Prisma } from "@prisma/client";
import { createMerchantI18n } from "@/utils/merchant-i18n";

const INVALID_PREFIX = "MERCHANT_PRICING_CATALOGUE_INVALID:";
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function parseProviderDecimal(value) {
  if (value === null || value === undefined) return null;
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function nonNegativeDecimal(value) {
  return value.lt(0) ? new Prisma.Decimal(0) : value;
}

function calculateProviderUsageCost(price, quantity) {
  if (!price || price.kind !== "TIERED" || !quantity?.isFinite?.() || quantity.lt(0) || !Array.isArray(price.tiers) || price.tiers.length === 0) return null;
  const tiers = price.tiers.map((tier) => ({
    upTo: tier.upTo === null ? null : parseProviderDecimal(tier.upTo),
    unit: parseProviderDecimal(tier.amountPerUnit),
    flat: parseProviderDecimal(tier.amount),
  }));
  if (tiers.some((tier) => !tier.unit || !tier.flat || tier.unit.lt(0) || tier.flat.lt(0) || (tier.upTo !== null && !tier.upTo))) return null;
  const mode = String(price.tiersMode ?? "").toUpperCase();
  if (mode === "VOLUME") {
    const tier = tiers.find((candidate) => candidate.upTo === null || quantity.lte(candidate.upTo));
    return tier ? tier.flat.plus(quantity.mul(tier.unit)) : null;
  }
  if (mode !== "GRADUATED") return null;
  let total = new Prisma.Decimal(0);
  let lower = new Prisma.Decimal(0);
  for (const tier of tiers) {
    const upper = tier.upTo ?? quantity;
    const segment = nonNegativeDecimal(quantity.lt(upper) ? quantity.minus(lower) : upper.minus(lower));
    total = total.plus(segment.mul(tier.unit).plus(tier.flat));
    if (quantity.lte(upper)) return total;
    lower = upper;
  }
  return null;
}

function resolveNextProviderUnitCost(providerItem) {
  const currency = providerItem?.price?.currency;
  const quantity = parseProviderDecimal(providerItem?.usage?.quantity);
  if (!currency || !quantity || quantity.lt(0)) return null;
  const before = calculateProviderUsageCost(providerItem.price, quantity);
  const after = calculateProviderUsageCost(providerItem.price, quantity.plus(1));
  if (!before || !after) return null;
  const delta = after.minus(before);
  if (!delta.isFinite() || delta.lt(0)) return null;
  return { amount: delta.toString(), currency };
}

function invalid(message) {
  throw new Error(`${INVALID_PREFIX} ${message}`);
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCurrency(currency, field) {
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    invalid(`${field} must be an uppercase ISO currency code`);
  }
}

function validateText(value, field, maxLength = Infinity) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    invalid(`${field} is invalid`);
  }
}

function validateUsageEvent(event, planCurrency, eventIndex) {
  const prefix = `usage event ${eventIndex}`;
  if (!event || !Array.isArray(event.tiers)) invalid(`${prefix} shape is invalid`);
  validateText(event.eventHandle, `${prefix} handle`);
  validateCurrency(event.currency, `${prefix} currency`);
  if (event.currency !== planCurrency) invalid(`${prefix} currency differs from plan`);
  if (!Number.isSafeInteger(event.creditsGrantedPerUnit) || event.creditsGrantedPerUnit <= 0) {
    invalid(`${prefix} creditsGrantedPerUnit is invalid`);
  }
  if (event.maximumUnitsPerBillingPeriod !== null && (!Number.isSafeInteger(event.maximumUnitsPerBillingPeriod) || event.maximumUnitsPerBillingPeriod <= 0)) {
    invalid(`${prefix} maximumUnitsPerBillingPeriod is invalid`);
  }

  if (event.pricingMode === "FIXED") {
    if (!isSafeNonNegativeInteger(event.fixedUnitAmountMinor) || event.tiers.length !== 0) {
      invalid(`${prefix} FIXED pricing is invalid`);
    }
  } else if (event.pricingMode === "GRADUATED" || event.pricingMode === "VOLUME") {
    if (event.fixedUnitAmountMinor !== null) {
      invalid(`${prefix} tiered pricing cannot have a fixed amount`);
    }
    if (!Array.isArray(event.tiers) || event.tiers.length < 1 || event.tiers.length > 6) {
      invalid(`${prefix} tier count is invalid`);
    }
    let previousUpperBound = 0;
    event.tiers.forEach((tier, tierIndex) => {
      if (tier.position !== tierIndex || !isSafeNonNegativeInteger(tier.amountPerUnitMinor) || !isSafeNonNegativeInteger(tier.flatAmountMinor)) {
        invalid(`${prefix} tier ${tierIndex} is invalid`);
      }
      if (tierIndex === event.tiers.length - 1) {
        if (tier.upTo !== null) invalid(`${prefix} final tier must be open-ended`);
      } else if (!Number.isSafeInteger(tier.upTo) || tier.upTo <= previousUpperBound) {
        invalid(`${prefix} tier ${tierIndex} upper bound is invalid`);
      }
      if (tier.upTo !== null) previousUpperBound = tier.upTo;
    });
  } else {
    invalid(`${prefix} pricing mode is invalid`);
  }
}

function validatePlan(plan, translation, planIndex) {
  const prefix = `plan ${planIndex}`;
  validateText(plan.shopifyPlanHandle, `${prefix} handle`);
  validateText(plan.displayName, `${prefix} display name`);
  if (!isSafeNonNegativeInteger(plan.cataloguePosition)) invalid(`${prefix} catalogue position is invalid`);
  validateText(translation?.merchantDescription, `${prefix} translation`, 2000);
  validateCurrency(plan.currency, `${prefix} currency`);
  if (!isSafeNonNegativeInteger(plan.recurringAmountMinor)) invalid(`${prefix} recurring amount is invalid`);
  if (!isSafeNonNegativeInteger(plan.includedRecoveryCredits)) invalid(`${prefix} included credits are invalid`);
  if (!Array.isArray(plan.usageEvents) || plan.usageEvents.length > 5) invalid(`${prefix} usage event count is invalid`);
  plan.usageEvents.forEach((event, eventIndex) => {
    if (event.position !== eventIndex) invalid(`${prefix} usage event order is invalid`);
    validateUsageEvent(event, plan.currency, eventIndex);
  });
}

function validateHighlights(highlights, planIndex) {
  let previousPosition = -1;
  highlights.forEach((highlight, highlightIndex) => {
    const prefix = `plan ${planIndex} highlight ${highlightIndex}`;
    if (!isSafeNonNegativeInteger(highlight.position) || highlight.position <= previousPosition) {
      invalid(`${prefix} position is invalid`);
    }
    previousPosition = highlight.position;
    validateText(highlight.contentKey, `${prefix} content key`);
    const translation = highlight.translations?.[0];
    if (highlight.translations?.length !== 1) invalid(`${prefix} translation is missing or duplicated`);
    validateText(translation?.merchantTitle, `${prefix} title`, 120);
    validateText(translation?.merchantDescription, `${prefix} description`, 2000);
  });
}

export async function readActiveMerchantPricingCatalogue({ locale } = {}) {
  const catalogueLocale = createMerchantI18n({ locale }).catalogueLocale;
  const plans = await db.merchantPricingPlan.findMany({
    where: { isActive: true },
    orderBy: { cataloguePosition: "asc" },
    include: {
      translations: { where: { locale: catalogueLocale } },
      usageEvents: {
        orderBy: { position: "asc" },
        include: { tiers: { orderBy: { position: "asc" } } },
      },
      highlights: {
        orderBy: { position: "asc" },
        include: { translations: { where: { locale: catalogueLocale } } },
      },
    },
  });

  let previousPosition = -1;
  return plans.map((plan, planIndex) => {
    if (plan.cataloguePosition <= previousPosition) invalid("catalogue positions are not strictly increasing");
    previousPosition = plan.cataloguePosition;
    if (plan.translations?.length !== 1) invalid(`plan ${planIndex} translation is missing or duplicated`);
    const translation = plan.translations[0];
    validatePlan(plan, translation, planIndex);
    validateHighlights(plan.highlights ?? [], planIndex);
    return {
      shopifyPlanHandle: plan.shopifyPlanHandle,
      displayName: plan.displayName,
      planKind: plan.planKind,
      cataloguePosition: plan.cataloguePosition,
      featured: plan.featured,
      localizedDescription: translation.merchantDescription,
      includedRecoveryCredits: plan.includedRecoveryCredits,
      allowancePeriod: plan.allowancePeriod,
      billingPeriod: plan.billingPeriod,
      recurringAmountMinor: plan.recurringAmountMinor,
      currency: plan.currency,
      highlights: (plan.highlights ?? []).map((highlight) => ({
        contentKey: highlight.contentKey,
        position: highlight.position,
        title: highlight.translations[0].merchantTitle,
        description: highlight.translations[0].merchantDescription,
      })),
      usageEvents: plan.usageEvents.map((event) => ({
        cataloguePosition: event.position,
        eventHandle: event.eventHandle,
        creditsGrantedPerUnit: event.creditsGrantedPerUnit,
        maximumUnitsPerBillingPeriod: event.maximumUnitsPerBillingPeriod,
        pricingMode: event.pricingMode,
        currency: event.currency,
        fixedUnitAmountMinor: event.fixedUnitAmountMinor,
        tiers: event.tiers.map(({ position, upTo, amountPerUnitMinor, flatAmountMinor }) => ({
          position,
          upTo,
          amountPerUnitMinor,
          flatAmountMinor,
        })),
      })),
    };
  });
}

export function resolveCurrentRecoveryCreditOffers({ providerSubscription, merchantPricingPlan }) {
  if (!providerSubscription || (providerSubscription.status !== "ACTIVE" && providerSubscription.status !== "TRIALING")) {
    throw new Error("A live provider subscription is required to resolve recovery-credit offers.");
  }

  if (!merchantPricingPlan || merchantPricingPlan.shopifyPlanHandle !== providerSubscription.planHandle) {
    return { offers: [], diagnostics: [] };
  }

  const providerItems = new Map(
    (providerSubscription.usageItems ?? [])
      .filter((item) => typeof item?.handle === "string" && item.handle.trim())
      .map((item) => [item.handle, item]),
  );
  const diagnostics = [];
  const offers = (merchantPricingPlan.usageEvents ?? [])
    .slice()
    .sort((left, right) => left.position - right.position)
    .flatMap((event) => {
      const providerItem = providerItems.get(event.eventHandle);
      if (!providerItem) return [];
      return [{
        eventHandle: event.eventHandle,
        cataloguePosition: event.position,
        creditsGranted: event.creditsGrantedPerUnit,
        providerPrice: providerItem.price,
        providerUsage: providerItem.usage,
        providerNextUnitCost: resolveNextProviderUnitCost(providerItem),
        purchaseEligible: true,
        blockReason: null,
        pendingPurchase: null,
      }];
    });

  for (const handle of providerItems.keys()) {
    if (!(merchantPricingPlan.usageEvents ?? []).some((event) => event.eventHandle === handle)) {
      if (diagnostics.length < 10) diagnostics.push({ code: "UNKNOWN_PROVIDER_METER", handle });
    }
  }

  return { offers, diagnostics };
}

export async function readMerchantPricingPlanForProvider({ planHandle } = {}) {
  validateText(planHandle, "provider plan handle");
  const plan = await db.merchantPricingPlan.findUnique({
    where: { shopifyPlanHandle: planHandle },
    include: {
      usageEvents: {
        orderBy: { position: "asc" },
        include: { tiers: { orderBy: { position: "asc" } } },
      },
    },
  });
  if (!plan) return null;
  validatePlan(plan, { merchantDescription: plan.displayName }, 0);
  return {
    shopifyPlanHandle: plan.shopifyPlanHandle,
    cataloguePosition: plan.cataloguePosition,
    usageEvents: plan.usageEvents.map((event) => ({
      cataloguePosition: event.position,
      position: event.position,
      eventHandle: event.eventHandle,
      creditsGrantedPerUnit: event.creditsGrantedPerUnit,
      maximumUnitsPerBillingPeriod: event.maximumUnitsPerBillingPeriod,
      pricingMode: event.pricingMode,
      currency: event.currency,
      fixedUnitAmountMinor: event.fixedUnitAmountMinor,
      tiers: event.tiers,
    })),
  };
}
