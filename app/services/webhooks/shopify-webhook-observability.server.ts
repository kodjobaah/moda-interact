import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import { recordShopifyWebhookTelemetry } from "../otel/shopify-webhook-telemetry.server";
import type { ShopifyWebhookObservation } from "./shopify-webhook-observation";
import type { ShopifyBrandReadGrant } from "../shopify-brand/shopify-brand-read-scope";

/**
 * One service logger per process, owned by the shared
 * `@modainteract/moda-interact-shared/logging` package. The canonical
 * telemetry identity (`service.name`, `service.namespace`,
 * `deployment.environment.name`) is resolved by moda-interact's own service
 * code and passed in; the shared library never reads service-specific
 * environment variables itself.
 */
const logger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});

/**
 * Records a Shopify webhook processing outcome: emits the structured log
 * record through the shared logger and records bounded Shopify-specific
 * OpenTelemetry spans/metrics. Logging and telemetry are strictly best-effort
 * and never affect webhook acceptance.
 */
export function recordShopifyWebhookOutcome(
  entry: ShopifyWebhookObservation,
): void {
  logger.info("shopify.webhook.outcome", {
    topic: entry.topic,
    deliveryId: entry.deliveryId,
    eventId: entry.eventId,
    queue: entry.queue,
    jobId: entry.jobId,
    outcome: entry.outcome,
    shopId: entry.shopId,
    shopDomain: entry.shopDomain,
    ackMs: entry.ackMs,
  });

  recordShopifyWebhookTelemetry(entry);
}

/**
 * Emits a bounded route-level receipt before authentication. This deliberately
 * records only the configured route and HTTP method because provider headers
 * and payload metadata are not trusted until Shopify authentication succeeds.
 */
export function recordShopifyWebhookReceived(input: {
  request: Request;
  route: string;
}): void {
  logger.info("shopify.webhook.received", {
    route: input.route,
    method: input.request.method,
  });
}

/**
 * Records a failed Shopify authentication attempt without logging untrusted
 * provider headers, payload data or an exception message that could contain
 * request content. The original error is always rethrown by the caller.
 */
export function recordShopifyWebhookAuthenticationFailure(input: {
  request: Request;
  route: string;
  error: unknown;
  ackMs: number;
}): void {
  logger.warn("shopify.webhook.authentication_failed", {
    route: input.route,
    method: input.request.method,
    statusCode: errorStatusCode(input.error),
    errorType: errorType(input.error),
    classification: input.error instanceof Response ? "sdk_denial" : "sdk_exception",
    origin: input.error instanceof Response ? "sdk_response" : "sdk_exception",
    ...safeErrorFields(input.error),
    ackMs: input.ackMs,
  });
}

/**
 * Records the final semantic outcome for Shopify webhook routes that do not go
 * through the generic ingress service (for example lifecycle and compliance
 * webhooks). The existing shared logger/Loki transport is reused; generic HTTP
 * telemetry remains framework-owned and no duplicate route metric/span is added.
 * No payload body or customer data is recorded.
 */
export function recordShopifyWebhookRouteOutcome(input: {
  request: Request;
  route: string;
  topic: string;
  eventId?: string | null;
  shopDomain: string;
  shopId?: string | null;
  outcome: string;
  brandReadScopeGrantFromWebhook?: ShopifyBrandReadGrant;
  statusCode?: number;
  ackMs: number;
}): void {
  logger.info("shopify.webhook.outcome", {
    route: input.route,
    method: input.request.method,
    statusCode: input.statusCode ?? 200,
    topic: input.topic,
    deliveryId: webhookDeliveryId(input.request),
    eventId: input.eventId ?? null,
    queue: null,
    jobId: null,
    outcome: input.outcome,
    ...(input.brandReadScopeGrantFromWebhook
      ? { brandReadScopeGrantFromWebhook: input.brandReadScopeGrantFromWebhook }
      : {}),
    shopId: input.shopId ?? null,
    shopDomain: input.shopDomain,
    ackMs: input.ackMs,
  });
}

/**
 * Emits a domain-semantic failure for an authenticated webhook route and then
 * leaves error handling to the existing route/framework path. Error messages
 * and payloads are intentionally excluded.
 */
export function recordShopifyWebhookRouteFailure(input: {
  request: Request;
  route: string;
  topic?: string | null;
  eventId?: string | null;
  shopDomain?: string | null;
  shopId?: string | null;
  error: unknown;
  ackMs: number;
  operation?: string;
  stage?: string;
  origin?: string;
}): void {
  logger.error("shopify.webhook.failed", {
    route: input.route,
    method: input.request.method,
    topic: input.topic ?? null,
    deliveryId: webhookDeliveryId(input.request),
    eventId: input.eventId ?? null,
    shopId: input.shopId ?? null,
    shopDomain: input.shopDomain ?? null,
    statusCode: errorStatusCode(input.error),
    errorType: errorType(input.error),
    ...(input.operation ? { operation: input.operation } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...safeErrorFields(input.error),
    ackMs: input.ackMs,
  });
}

export function recordShopifyLifecycleFailure(input: {
  operation: string;
  stage: string;
  origin: string;
  error: unknown;
  shopId?: string;
}): void {
  logger.error("shopify.lifecycle.failed", {
    operation: input.operation,
    stage: input.stage,
    origin: input.origin,
    ...(input.shopId ? { shopId: input.shopId } : {}),
    ...safeErrorFields(input.error),
  });
}

function safeErrorFields(value: unknown): Record<string, unknown> {
  const original = value instanceof Error ? value : new Error(String(value));
  const causes: Error[] = [];
  let cause = original.cause;
  for (let index = 0; index < 4 && cause instanceof Error; index += 1) {
    causes.push(cause);
    cause = cause.cause;
  }
  const safeError = (error: Error) => ({
    name: safeDiagnosticText(error.name).slice(0, 256),
    message: safeDiagnosticText(error.message).slice(0, 2048),
  });
  const codedError = [original, ...causes].find(
    (error) => "code" in error && typeof error.code === "string",
  ) as (Error & { code: string }) | undefined;
  const code = codedError ? safeDiagnosticText(codedError.code).slice(0, 128) : undefined;

  return {
    error: safeError(original),
    ...(causes.length > 0 ? { causeChain: causes.map(safeError) } : {}),
    ...(code ? { databaseCode: code } : {}),
    redactionApplied: [original, ...causes].some(
      (error) => safeDiagnosticText(error.message) !== error.message,
    ),
    truncated: [original, ...causes].some((error) => error.message.length > 2048),
  };
}

function safeDiagnosticText(value: string): string {
  return value
    .replace(/(?:https?|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(?:token|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|email|phone|address)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\+?\d[\d ()-]{8,}\d/g, "[REDACTED]");
}

function webhookDeliveryId(request: Request): string {
  return request.headers.get("x-shopify-webhook-id")?.trim() || "unknown";
}

function errorStatusCode(error: unknown): number | null {
  return error instanceof Response ? error.status : null;
}

function errorType(error: unknown): string {
  if (error instanceof Response) {
    return "Response";
  }
  if (error instanceof Error) {
    return error.name || "Error";
  }
  return typeof error;
}
