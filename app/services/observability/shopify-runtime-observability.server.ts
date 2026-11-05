import { createLogger, sanitizeLogFields } from "@modainteract/moda-interact-shared/logging";
import { isRouteErrorResponse } from "react-router";
import { logBillingBoundaryFailure, safeText } from "../billing/providers/shopify-billing-diagnostics.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";

const logger = createLogger({serviceName: "moda-interact", environment: resolveDeploymentEnvironmentName()});
const method = (value?: string) => value && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(value) ? value : "OTHER";
function expected(error: unknown): boolean {
  return (error instanceof Response || isRouteErrorResponse(error)) && error.status >= 300 && error.status < 500;
}

export function recordUnhandledRequestFailure(input: {error: unknown; method?: string}): void {
  if (expected(input.error)) return;
  logBillingBoundaryFailure({event: "shopify.request.unhandled", operation: "loader_action", stage: "framework", error: input.error},
    logger.child(sanitizeLogFields({method: method(input.method)})));
}
export function recordServerRenderFailure(input: {error: unknown; stage: "shell" | "render"}): void {
  if (expected(input.error)) return;
  logBillingBoundaryFailure({event: "shopify.server.render_failed", operation: "server_render", stage: input.stage, origin: "internal", error: input.error}, logger);
}
export function recordShopifyBootstrapFailure(input: {error: unknown; stage: "oauth_configuration" | "sdk_construction"; sensitiveValues?: string[]}): void {
  logBillingBoundaryFailure({event: "shopify.bootstrap.failed", operation: "shopify_bootstrap", stage: input.stage,
    origin: "internal", error: input.error, sensitiveValues: input.sensitiveValues}, logger);
}

/** Installed SDK supplies severity and formatted text only; never reconstruct opaque context fields. */
export function recordShopifySdkDiagnostic(input: {severity: number; message: string; sensitiveValues?: string[]}): void {
  const suffix = input.message.indexOf(" | {");
  let message = suffix >= 0 ? input.message.slice(0, suffix) : input.message;
  const opaque = message.search(/[{}\r\n]|\[\s*["{]|\b(?:request|response|session|headers|body|payload|variables|data)\s*[:=]/i);
  const privacyOmitted = opaque >= 0;
  if (privacyOmitted) message = `${message.slice(0, opaque).trimEnd()} [REDACTED]`;
  const safe = safeText(message, input.sensitiveValues ?? []);
  const level = input.severity === 0 ? "error" : input.severity === 1 ? "warn" : input.severity === 2 ? "info" : "debug";
  logger[level]("shopify.sdk.diagnostic", sanitizeLogFields({
    operation: "sdk_log", stage: "sdk_callback", origin: "sdk_exception", sdkSeverity: input.severity,
    message: safe?.value ?? "[REDACTED]", redactionApplied: suffix >= 0 || privacyOmitted || Boolean(safe?.redacted),
    truncated: Boolean(safe?.truncated), ...(privacyOmitted ? {reasonCode: "OPAQUE_SDK_CONTENT_OMITTED"} : {}),
  }));
}

export function recordTelemetryProbeFailure(input: {error?: unknown; stage: "network" | "response"; httpStatus?: number; sensitiveValues?: string[]}): void {
  logBillingBoundaryFailure({event: "telemetry.probe.dependency_failed", operation: "telemetry_probe_fetch", stage: input.stage,
    origin: input.stage === "network" ? "transport" : "provider_response", error: input.error,
    reasonCode: input.stage === "response" ? "HTTP_NON_SUCCESS" : undefined, sensitiveValues: input.sensitiveValues},
    logger.child(input.httpStatus === undefined ? {} : {httpStatus: input.httpStatus}));
}
