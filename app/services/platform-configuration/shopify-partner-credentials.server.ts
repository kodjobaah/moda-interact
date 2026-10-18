import { configurationFailure, type ShopifyPartnerCredentials } from "./contracts.server";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^20\d{2}-(?:01|04|07|10)$/;

export function decodeShopifyPartnerCredentials(version: number, value: unknown): ShopifyPartnerCredentials {
  const key = "shopify.partner";
  if (!value || typeof value !== "object" || Array.isArray(value)) configurationFailure(key, "INVALID_VALUE");
  const record = value as Record<string, unknown>;
  const required = ["accessToken", "organizationId", "appId"];
  const allowed = [...required, "apiVersion"];
  if (Object.keys(record).some((field) => !allowed.includes(field)) ||
      required.some((field) => !Object.hasOwn(record, field)) ||
      !isToken(record.accessToken) || typeof record.organizationId !== "string" ||
      !ID.test(record.organizationId) || typeof record.appId !== "string" ||
      !ID.test(record.appId) ||
      (record.apiVersion !== undefined && (typeof record.apiVersion !== "string" || !VERSION.test(record.apiVersion)))) {
    configurationFailure(key, "INVALID_VALUE");
  }
  return Object.freeze({
    version,
    accessToken: record.accessToken as string,
    organizationId: record.organizationId as string,
    appId: record.appId as string,
    ...(record.apiVersion !== undefined ? { apiVersion: record.apiVersion as string } : {}),
  });
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 4096 &&
    value.trim() === value &&
    // Intentional rejection of ASCII control characters in credential values.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value);
}
