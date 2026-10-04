import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "@/services/otel/otel.runtime";

export type MerchantKnowledgeUploadFailureStage =
  | "intent"
  | "storage_put"
  | "client_hash"
  | "finalize";

const logger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});

function boundedString(value: unknown, maxLength = 128): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function boundedInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function recordMerchantKnowledgeUploadFailure(input: {
  stage: MerchantKnowledgeUploadFailureStage;
  shopId: string;
  assetId?: unknown;
  purposeKey?: unknown;
  dataFormatKey?: unknown;
  sizeBytes?: unknown;
  contentType?: unknown;
  statusCode?: unknown;
  errorCode: string;
  error?: unknown;
}): void {
  const data: Record<string, unknown> = {
    stage: input.stage,
    shopId: input.shopId.slice(0, 128),
    errorCode: input.errorCode.slice(0, 96),
  };

  const assetId = boundedString(input.assetId);
  const purposeKey = boundedString(input.purposeKey, 64);
  const dataFormatKey = boundedString(input.dataFormatKey, 64);
  const sizeBytes = boundedInteger(input.sizeBytes);
  const contentType = boundedString(input.contentType, 160);
  const statusCode = boundedInteger(input.statusCode);

  if (assetId) data.assetId = assetId;
  if (purposeKey) data.purposeKey = purposeKey;
  if (dataFormatKey) data.dataFormatKey = dataFormatKey;
  if (sizeBytes !== null) data.sizeBytes = sizeBytes;
  if (contentType) data.contentType = contentType;
  if (statusCode !== null) data.statusCode = statusCode;
  if (input.error !== undefined) {
    data.errorType = input.error instanceof Error
      ? boundedString(input.error.name, 64) ?? "Error"
      : typeof input.error;
  }

  logger.error("merchant_knowledge.upload.failed", data);
}
