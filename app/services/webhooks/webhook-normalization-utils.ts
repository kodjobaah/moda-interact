// Repository-local timestamp normalisation shared by the recovery-focused
// webhook normalizers (ARCH-001-SHOPIFY-001).
//
// Shopify delivers provider timestamps that may carry an explicit UTC offset
// (e.g. "2021-12-31T19:00:00-05:00"), while the canonical v2 contract expects
// a UTC ISO `Z` datetime. Normalise any valid provider timestamp to the
// canonical UTC ISO form so the shared runtime schema parse does not reject a
// legitimate Shopify delivery. Values that are not valid timestamps are
// reported as null so callers can apply their own required/nullable policy.

export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}
