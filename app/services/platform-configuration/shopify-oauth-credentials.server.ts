import { configurationFailure, type ShopifyOAuthCredentials } from "./contracts.server";

export function decodeShopifyOAuthCredentials(version: number, value: unknown): ShopifyOAuthCredentials {
  const key = "shopify.oauth";
  if (!value || typeof value !== "object" || Array.isArray(value)) configurationFailure(key, "INVALID_VALUE");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "apiKey") ||
      !Object.hasOwn(record, "apiSecret") || !validCredential(record.apiKey) || !validCredential(record.apiSecret)) {
    configurationFailure(key, "INVALID_VALUE");
  }
  return Object.freeze({ version, apiKey: record.apiKey as string, apiSecret: record.apiSecret as string });
}

function validCredential(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 4096 &&
    value.trim() === value &&
    // Intentional rejection of ASCII control characters in credential values.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value);
}
