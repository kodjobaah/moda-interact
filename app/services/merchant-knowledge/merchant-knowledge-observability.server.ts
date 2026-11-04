import { createLogger, sanitizeLogFields } from "@modainteract/moda-interact-shared/logging";
import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";
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
  data.origin = input.error === undefined ? "client_reported" : "internal";
  if (input.error !== undefined) {
    recordMerchantKnowledgeFailure({shopId: input.shopId, operation: input.stage, error: input.error}); return;
  }

  logger.error("merchant_knowledge.upload.failed", data);
}

const diagnosed = Symbol("knowledgeSourceDiagnostic");
export const knowledgeFailureRecorded = (error: unknown) => error !== null && typeof error === "object" && (error as Record<symbol, unknown>)[diagnosed] === true;
/** Knowledge owns source extraction; existing Shared boundary owns serialization/bounds. */
export function recordMerchantKnowledgeFailure(input: {
  shopId: string; operation: string; error: unknown; origin?: "database" | "internal" | "transport" | "sdk_exception" | "provider_response";
  warn?: boolean; diagnosticError?: Error; redactionApplied?: boolean; sensitiveValues?: readonly string[]; providerMetadata?: Record<string, unknown>;
}) {
  if (knowledgeFailureRecorded(input.error)) return;
  if (input.error !== null && typeof input.error === "object") {
    try { Object.defineProperty(input.error, diagnosed, {value: true}); } catch { /* Frozen source still receives diagnostics. */ }
  }
  const root = input.error;
  const firstCause = root instanceof Error ? root.cause : undefined;
  const secondCause = firstCause instanceof Error ? firstCause.cause : undefined;
  const thirdCause = secondCause instanceof Error ? secondCause.cause : undefined;
  const sourceChain = [root, firstCause, secondCause, thirdCause];
  const sourceCode = sourceChain.map(value => value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value.code) ? value.code : undefined).find(Boolean);
  const databaseCode = sourceChain.map(value => value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value.code) ? value.code : undefined)
    .find(code => code !== undefined && (/^P\d{4}$/.test(code) || /^(?:[0-9]{2}[A-Z0-9]{3})$/.test(code)));
  const origin = input.origin ?? (databaseCode || sourceChain.some(value => value instanceof Error && value.name.startsWith("PrismaClient")) ? "database" : sourceCode && /^E[A-Z_]+$/.test(sourceCode) ? "transport" : "internal");
  const sensitive = input.sensitiveValues?.filter(Boolean) ?? [];
  const safe = (message: string) => sensitive.reduce((value, part) => value.split(part).join("[REDACTED]"), message);
  let sourceCauseTruncated = false;
  let diagnostic = input.diagnosticError ?? input.error;
  if (sensitive.length && diagnostic instanceof Error) {
    const original = diagnostic;
    const chain = [original, original.cause, original.cause instanceof Error ? original.cause.cause : undefined,
      original.cause instanceof Error && original.cause.cause instanceof Error ? original.cause.cause.cause : undefined].filter((value): value is Error => value instanceof Error);
    sourceCauseTruncated = chain.length === 4 && chain[3].cause !== undefined;
    let cause: Error | undefined;
    for (const value of chain.reverse()) {
      const copy: Error = new Error(safe(value.message), cause ? {cause} : undefined); copy.name = safe(value.name);
      if ("code" in value && typeof value.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value.code)) Object.assign(copy, {code: safe(value.code)});
      cause = copy;
    }
    diagnostic = cause;
  }
  const metadata = Object.fromEntries(Object.entries(input.providerMetadata ?? {}).map(([key, value]) => [key, typeof value === "string" ? safe(value) : value]));
  const metadataRedacted = Object.entries(input.providerMetadata ?? {}).some(([key, value]) => metadata[key] !== value);
  const target = logger.child(sanitizeLogFields({ ...metadata,
    ...(sensitive.length ? { redactionApplied: diagnostic instanceof Error && input.error instanceof Error && diagnostic.message !== input.error.message } : {}) }));
  logBillingBoundaryFailure({event: "merchant_knowledge.operation.failed", operation: input.operation, stage: input.operation,
    shopId: input.shopId, origin, error: diagnostic}, { ...target, error: (event, fields) => {
      const redacted = metadataRedacted || Boolean(sourceCode && safe(sourceCode) !== sourceCode) || input.error instanceof Error && sensitive.some(part => input.error instanceof Error && [input.error.message, input.error.cause instanceof Error ? input.error.cause.message : ""].some(message => message.includes(part)));
      const emit = input.warn ? target.warn : target.error;
      const evidence: Record<string, unknown> = {...fields, redactionApplied: input.redactionApplied === true || Boolean(fields?.redactionApplied) || redacted, truncated: sourceCauseTruncated || Boolean(fields?.truncated)};
      delete evidence.databaseCode;
      if (origin === "database" && databaseCode) evidence.databaseCode = databaseCode;
      if (sourceCode && sourceCode !== databaseCode) evidence.sourceCode = safe(sourceCode);
      emit(event, evidence);
    } });
}
