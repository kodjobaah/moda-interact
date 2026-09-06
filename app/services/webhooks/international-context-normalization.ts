import {
  canonicaliseLanguageTag,
  normalizeCountryCode,
  normalizeCurrencyCode,
  type InternationalContext,
} from "@modainteract/moda-interact-shared/internationalization";

function nestedRecord(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = payload[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeField(
  value: unknown,
  normalize: (value: string) => string,
): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return normalize(value);
  } catch {
    return null;
  }
}

export function normalizeShopifyInternationalContext(
  payload: Record<string, unknown>,
): InternationalContext | undefined {
  const billingAddress = nestedRecord(payload, "billing_address");
  const languageTag = normalizeField(
    payload.customer_locale,
    canonicaliseLanguageTag,
  );
  const countryCode = normalizeField(
    billingAddress?.country_code,
    normalizeCountryCode,
  );
  const currencyCode = normalizeField(
    payload.presentment_currency,
    normalizeCurrencyCode,
  );

  if (!languageTag && !countryCode && !currencyCode) {
    return undefined;
  }

  return {
    languageTag,
    languageSource: languageTag ? "shopify" : null,
    countryCode,
    currencyCode,
    timeZone: null,
  };
}