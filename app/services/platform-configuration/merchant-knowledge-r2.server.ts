import { configurationFailure, type MerchantKnowledgeR2Configuration } from "./contracts.server";

const KEY = "merchant.knowledge.r2";
const ENDPOINT = /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/i;
const BUCKET = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function closedRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = ["endpoint", "bucket", "accessKeyId", "secretAccessKey", "maxUploadBytes", "maxXlsxUncompressedBytes"];
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function validSecret(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    value.trim() === value &&
    // Intentional rejection of ASCII control characters in credential values.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function decodeMerchantKnowledgeR2Configuration(
  version: number, value: unknown,
): MerchantKnowledgeR2Configuration {
  if (!closedRecord(value) || !validSecret(value.accessKeyId, 4096) ||
      !validSecret(value.secretAccessKey, 4096) ||
      typeof value.endpoint !== "string" || !ENDPOINT.test(value.endpoint) ||
      typeof value.bucket !== "string" || !BUCKET.test(value.bucket) ||
      !Number.isSafeInteger(value.maxUploadBytes) || (value.maxUploadBytes as number) < 1 ||
      (value.maxUploadBytes as number) > 25 * 1024 * 1024 ||
      !Number.isSafeInteger(value.maxXlsxUncompressedBytes) || (value.maxXlsxUncompressedBytes as number) < 1 ||
      (value.maxXlsxUncompressedBytes as number) > 2_147_483_647 ||
      (value.maxXlsxUncompressedBytes as number) < (value.maxUploadBytes as number)) {
    configurationFailure(KEY, "INVALID_VALUE");
  }
  return Object.freeze({
    version,
    endpoint: value.endpoint as string,
    bucket: value.bucket as string,
    accessKeyId: value.accessKeyId as string,
    secretAccessKey: value.secretAccessKey as string,
    maxUploadBytes: value.maxUploadBytes as number,
    maxXlsxUncompressedBytes: value.maxXlsxUncompressedBytes as number,
  });
}
