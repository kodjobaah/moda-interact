// @ts-nocheck

import db from "@/db.server";
import { createMerchantI18n } from "@/utils/merchant-i18n";

const INVALID_PREFIX = "MERCHANT_PRICING_CATALOGUE_INVALID:";
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

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
