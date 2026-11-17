const MARKER_PATTERN = /^m1_[A-Za-z0-9_-]{43}$/;

export function isShopifyConsentMarker(value: unknown): value is string {
  if (typeof value !== "string" || !MARKER_PATTERN.test(value)) return false;
  const encoded = value.slice(3);
  const decoded = Buffer.from(encoded, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === encoded;
}
