import type { ShopifyWebhookPublicationError } from "./shopify-webhook-queue.server";
import {
  createLogger,
  sanitizeLogFields,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import {
  logBillingBoundaryFailure,
  type ShopifyBillingFailureOrigin,
} from "../billing/providers/shopify-billing-diagnostics.server";
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
  logBillingBoundaryFailure({
    event: "shopify.webhook.authentication_failed",
    operation: "authenticate_webhook",
    stage: "authentication",
    origin: "internal",
    error: input.error,
  }, diagnosticLogger(
    input.error instanceof Response ? "sdk_response" : "sdk_exception",
    {
      route: input.route,
      method: input.request.method,
      statusCode: errorStatusCode(input.error),
      errorType: errorType(input.error),
      classification: input.error instanceof Response ? "sdk_denial" : "sdk_exception",
      ackMs: input.ackMs,
    },
    "warn",
  ));
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
 * leaves error handling to the existing route/framework path. Source messages
 * use the existing sanitized diagnostic projection; payload contents stay excluded.
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
  const publication = publicationDiagnosticContext(input.error);
  const origin = input.origin ?? (publication?.publicationStage === "add" ? "transport" : "internal");
  logBillingBoundaryFailure({
    event: "shopify.webhook.failed",
    operation: input.operation ?? input.route,
    stage: input.stage ?? "route_failure",
    origin: billingFailureOrigin(origin),
    shopId: input.shopId ?? undefined,
    error: input.error,
  }, diagnosticLogger(origin, {
    ...publication,
    route: input.route,
    method: input.request.method,
    topic: input.topic ?? null,
    deliveryId: webhookDeliveryId(input.request),
    eventId: input.eventId ?? null,
    shopDomain: input.shopDomain ?? null,
    statusCode: errorStatusCode(input.error),
    errorType: errorType(input.error),
    ackMs: input.ackMs,
  }, "error", publication !== undefined));
}

export function recordShopifyLifecycleFailure(input: {
  operation: string;
  stage: string;
  origin: string;
  error: unknown;
  shopId?: string;
}): void {
  const publication = publicationDiagnosticContext(input.error);
  const origin = publication ? publication.publicationStage === "add" ? "transport" : "internal" : input.origin;
  logBillingBoundaryFailure({
    event: "shopify.lifecycle.failed",
    operation: input.operation,
    stage: input.stage,
    origin: billingFailureOrigin(origin),
    ...(input.shopId ? { shopId: input.shopId } : {}),
    error: input.error,
  }, diagnosticLogger(origin, publication, "error", publication !== undefined));
}

/** Keep an existing publication wrapper for propagation/deduplication while exposing its source code. */
function publicationDiagnosticContext(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error) || error.name !== "ShopifyWebhookPublicationError" || !("code" in error)) return;
  const publication = error as ShopifyWebhookPublicationError;
  if (!["REDIS_UNAVAILABLE", "PUBLICATION_TIMEOUT", "QUEUE_ADD_FAILED"].includes(publication.code)) return;
  const source = publication.cause;
  const code = source && typeof source === "object" && "code" in source ? source.code : undefined;
  return { reasonCode: publication.code, publicationStage: publication.stage,
    queue: publication.queue ?? null, jobId: publication.jobId ?? null,
    ...(typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(code) ? {sourceCode: code} : {}),
  };
}

/** Generic ingress owns typed publication failures converted to 503; wrappers only propagate. */
export function recordShopifyWebhookPublicationFailure(input: {
  error: ShopifyWebhookPublicationError; topic: string; deliveryId: string;
  shopId?: string; queue?: string; jobId?: string;
}): void {
  const source = input.error.cause === undefined ? input.error : input.error.cause;
  const origin = input.error.stage === "add" ? "transport" : "internal";
  logBillingBoundaryFailure({
    event: "shopify.webhook.publication_failed", operation: "publish_webhook", stage: input.error.stage,
    origin, error: source, ...(input.shopId ? { shopId: input.shopId } : {}),
  }, diagnosticLogger(origin, {
    topic: input.topic, deliveryId: input.deliveryId, queue: input.queue ?? input.error.queue ?? null,
    jobId: input.jobId ?? input.error.jobId ?? null, reasonCode: input.error.code,
  }, "error", input.error.cause === undefined));
}

/** An idle producer's connection event has no request owner. Never include connection configuration. */
export function recordShopifyWebhookQueueFailure(input: { queue: string; stage: string; error: unknown }): void {
  logBillingBoundaryFailure({ event: "shopify.webhook.queue_failed", operation: "queue_connection", stage: input.stage,
    origin: "transport", error: input.error,
  }, diagnosticLogger("transport", { queue: input.queue }));
}

function diagnosticLogger(
  origin: string,
  context: Record<string, unknown> = {},
  level: "error" | "warn" = "error",
  omitSourceCode = false,
): StructuredLogger {
  const scopedLogger = logger.child(sanitizeLogFields(context));
  return {
    ...scopedLogger,
    error(event, fields = {}) {
      const { databaseCode, ...safeFields } = fields;
      scopedLogger[level](event, {
        ...safeFields,
        origin,
        ...(typeof databaseCode === "string" && !omitSourceCode
          ? origin === "database" ? { databaseCode } : { sourceCode: databaseCode }
          : {}),
      });
    },
  };
}

function billingFailureOrigin(origin: string): ShopifyBillingFailureOrigin {
  switch (origin) {
    case "provider_response":
    case "transport":
    case "sdk_exception":
    case "database":
      return origin;
    default:
      return "internal";
  }
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
