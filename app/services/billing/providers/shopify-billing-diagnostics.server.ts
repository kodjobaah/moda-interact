import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";

import { resolveDeploymentEnvironmentName } from "../../otel/otel.runtime";
import type { BillingVerificationFailure } from "../billing.types";

export type ShopifyBillingFailureKind =
  | "HTTP"
  | "GRAPHQL"
  | "TRANSPORT"
  | "MALFORMED_RESPONSE"
  | "CONFIGURATION";

export type ShopifyBillingFailureOrigin =
  | "provider_response"
  | "transport"
  | "sdk_exception"
  | "database"
  | "internal";

export type ShopifyBillingProviderErrorInput = {
  operation: string;
  failureKind: ShopifyBillingFailureKind;
  origin: ShopifyBillingFailureOrigin;
  message: string;
  cause?: unknown;
  diagnosticCause?: unknown;
  reasonCode?: string;
  httpStatus?: number;
  providerRequestId?: string | null;
  providerErrors?: Array<{
    code?: unknown;
    message?: unknown;
    details?: unknown;
  }>;
  providerErrorExcerpt?: string;
  sensitiveValues?: string[];
};

type SafeText = { value: string; redacted: boolean; truncated: boolean };

const logger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});
const diagnosedFailure = Symbol("billingDiagnosticEmitted");

export class ShopifyBillingProviderError extends Error {
  readonly failureKind: ShopifyBillingFailureKind;
  readonly origin: ShopifyBillingFailureOrigin;
  sourceDiagnosticEmitted = false;

  constructor(input: ShopifyBillingProviderErrorInput) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "ShopifyBillingProviderError";
    this.failureKind = input.failureKind;
    this.origin = input.origin;
  }
}

export function classifyBillingVerificationFailure(
  error: unknown,
  occurredAt = new Date(),
): Exclude<BillingVerificationFailure, null> {
  const providerFailure = error instanceof ShopifyBillingProviderError &&
    ["HTTP", "GRAPHQL", "TRANSPORT", "MALFORMED_RESPONSE"].includes(error.failureKind) &&
    ["provider_response", "transport"].includes(error.origin);
  return {
    code: providerFailure ? "PARTNER_API_ERROR" : "SUBSCRIPTION_SYNC_FAILED",
    occurredAt,
  };
}

export function safeText(value: unknown, sensitiveValues: string[], maxLength = 2048): SafeText | null {
  if (typeof value !== "string") return null;
  let text = value;
  let redacted = false;
  for (const secret of sensitiveValues) {
    if (secret && text.includes(secret)) {
      text = text.split(secret).join("[REDACTED]");
      redacted = true;
    }
  }
  const beforePatterns = text;
  text = text
    .replace(/(?:https?|postgres(?:ql)?|rediss?):\/\/[^\s"'<>]+/gi, "[REDACTED]")
    .replace(/(?:Bearer\s+|(?:access[_-]?token|authorization|cookie|password|email|phone|address|customer|card|payment)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]");
  const timestamps = Array.from(
    text.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,})?Z\b/g),
    (match) => ({ start: match.index!, end: match.index! + match[0].length }),
  );
  text = text.replace(/\+?\d[\d ()-]{8,}\d/g, (match, offset: number) => {
    const matchEnd = offset + match.length;
    const overlappingTimestamps = timestamps.filter((timestamp) => offset < timestamp.end && matchEnd > timestamp.start);
    if (overlappingTimestamps.length === 0) return "[REDACTED]";

    const redactSpan = (span: string) => {
      if (!span.trim()) return span;
      const leadingWhitespace = span.match(/^\s*/)?.[0] ?? "";
      const trailingWhitespace = span.match(/\s*$/)?.[0] ?? "";
      return `${leadingWhitespace}[REDACTED]${trailingWhitespace}`;
    };
    let safeMatch = "";
    let cursor = offset;
    for (const timestamp of overlappingTimestamps) {
      const start = Math.max(offset, timestamp.start);
      const end = Math.min(matchEnd, timestamp.end);
      if (start > cursor) safeMatch += redactSpan(text.slice(cursor, start));
      safeMatch += text.slice(start, end);
      cursor = end;
    }
    if (cursor < matchEnd) safeMatch += redactSpan(text.slice(cursor, matchEnd));
    return safeMatch;
  });
  redacted ||= text !== beforePatterns;
  const truncated = text.length > maxLength;
  return { value: text.slice(0, maxLength), redacted, truncated };
}

function safeErrorValue(error: unknown, sensitiveValues: string[]) {
  if (error instanceof Error) {
    const name = safeText(error.name, sensitiveValues, 128);
    const message = safeText(error.message, sensitiveValues);
    return {
      value: {
        name: name?.value ?? "Error",
        message: message?.value ?? "[REDACTED]",
      },
      redacted: Boolean(name?.redacted || message?.redacted),
      truncated: Boolean(name?.truncated || message?.truncated),
    };
  }
  const message = safeText(String(error), sensitiveValues);
  return {
    value: { name: typeof error, message: message?.value ?? "[REDACTED]" },
    redacted: Boolean(message?.redacted),
    truncated: Boolean(message?.truncated),
  };
}

function safeProviderErrors(input: ShopifyBillingProviderErrorInput) {
  const entries = input.providerErrors ?? [];
  let redacted = false;
  let truncated = entries.length > 5;
  const errors = entries.slice(0, 5).map((entry) => {
    const code = safeText(entry.code, input.sensitiveValues ?? [], 128);
    const message = safeText(entry.message, input.sensitiveValues ?? []);
    const details = safeText(entry.details, input.sensitiveValues ?? []);
    redacted ||= Boolean(code?.redacted || message?.redacted || details?.redacted);
    truncated ||= Boolean(code?.truncated || message?.truncated || details?.truncated);
    return {
      ...(code ? { code: code.value } : {}),
      ...(message ? { message: message.value } : {}),
      ...(details ? { details: details.value } : {}),
    };
  });
  return { errors, redacted, truncated };
}

function causeChain(error: unknown, sensitiveValues: string[]) {
  const causes: Array<{ name: string; message: string }> = [];
  let current = error instanceof Error ? error.cause : undefined;
  let redacted = false;
  let truncated = false;
  for (let index = 0; index < 4 && current !== undefined; index++) {
    const safe = safeErrorValue(current, sensitiveValues);
    causes.push(safe.value);
    redacted ||= safe.redacted;
    truncated ||= safe.truncated;
    current = current instanceof Error ? current.cause : undefined;
  }
  return { causes, redacted, truncated };
}

function databaseCode(error: unknown): string | undefined {
  let current = error;
  for (let index = 0; index < 5 && current !== undefined; index++) {
    if (typeof current === "object" && current !== null && "code" in current &&
      typeof current.code === "string") return current.code;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function createShopifyBillingProviderError(
  input: ShopifyBillingProviderErrorInput,
  diagnosticLogger: StructuredLogger = logger,
): ShopifyBillingProviderError {
  const safeMessage = safeText(input.message, input.sensitiveValues ?? []);
  const normalizedInput = {
    ...input,
    message: safeMessage?.value ?? "Shopify billing provider failure",
  };
  const error = new ShopifyBillingProviderError(normalizedInput);
  const safeError = safeErrorValue(error, input.sensitiveValues ?? []);
  const diagnosticError = input.diagnosticCause === undefined
    ? error
    : new Error("Sanitized diagnostic cause", { cause: input.diagnosticCause });
  const causes = causeChain(
    diagnosticError,
    input.sensitiveValues ?? [],
  );
  const providerErrors = safeProviderErrors(input);
  const excerpt = safeText(input.providerErrorExcerpt, input.sensitiveValues ?? []);
  const requestId = safeText(input.providerRequestId, input.sensitiveValues ?? [], 128);
  const redactionApplied = Boolean(safeMessage?.redacted) || safeError.redacted || causes.redacted || providerErrors.redacted ||
    Boolean(excerpt?.redacted || requestId?.redacted);
  const truncated = Boolean(safeMessage?.truncated) || safeError.truncated || causes.truncated || providerErrors.truncated ||
    Boolean(excerpt?.truncated || requestId?.truncated);

  diagnosticLogger.error("shopify.billing.provider_failed", {
    operation: input.operation,
    origin: input.origin,
    failureKind: input.failureKind,
    provider: "shopify",
    error: safeError.value,
    causeChain: causes.causes,
    ...(databaseCode(input.cause) ? { databaseCode: databaseCode(input.cause) } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
    ...(requestId ? { providerRequestId: requestId.value } : {}),
    ...(providerErrors.errors.length ? { providerErrors: providerErrors.errors } : {}),
    ...(excerpt ? { providerErrorExcerpt: excerpt.value } : {}),
    redactionApplied,
    truncated,
  });
  error.sourceDiagnosticEmitted = true;
  return error;
}

export function logBillingBoundaryFailure(input: {
  event: string;
  operation: string;
  stage: string;
  shopId?: string;
  identities?: Record<string, string | null>;
  error?: unknown;
  origin?: ShopifyBillingFailureOrigin;
  reasonCode?: string;
  diagnosticError?: unknown;
  sensitiveValues?: string[];
  redactionApplied?: boolean;
  truncated?: boolean;
}, diagnosticLogger: StructuredLogger = logger): void {
  if (input.error instanceof ShopifyBillingProviderError && input.error.sourceDiagnosticEmitted) return;
  if (typeof input.error === "object" && input.error !== null) {
    const state = input.error as Record<PropertyKey, unknown>;
    if (state[diagnosedFailure] === true) return;
    try {
      Object.defineProperty(input.error, diagnosedFailure, { value: true });
    } catch {
      // Frozen errors still get a diagnostic; deduplication is best-effort.
    }
  }

  const diagnostic = input.diagnosticError === undefined ? input.error : input.diagnosticError;
  const sensitive = input.sensitiveValues ?? [];
  const safeError = diagnostic === undefined ? null : safeErrorValue(diagnostic, sensitive);
  const causes = diagnostic === undefined ? null : causeChain(diagnostic, sensitive);
  const identities = Object.fromEntries(Object.entries(input.identities ?? {}).map(([key, value]) => {
    const safe = safeText(value, sensitive, 256);
    return [key, safe?.value ?? null];
  }));
  const code = diagnostic === undefined ? undefined : databaseCode(diagnostic);
  try {
    diagnosticLogger.error(input.event, {
      operation: input.operation,
      stage: input.stage,
      origin: input.origin ?? (code ? "database" : "internal"),
      ...(input.shopId ? { shopId: input.shopId } : {}),
      ...(Object.keys(identities).length ? { identities } : {}),
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(safeError ? { error: safeError.value } : {}),
      ...(causes ? { causeChain: causes.causes } : {}),
      ...(code ? { databaseCode: code } : {}),
      redactionApplied: Boolean(input.redactionApplied || safeError?.redacted || causes?.redacted),
      truncated: Boolean(input.truncated || safeError?.truncated || causes?.truncated),
    });
  } catch {
    // Diagnostics must not change the failure or best-effort policy of the caller.
  }
}