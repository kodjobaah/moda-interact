import { context, trace } from "@opentelemetry/api";
import { INVALID_TRACE_ID } from "./otel.constants";

/**
 * Lightweight OpenTelemetry runtime helpers for application modules.
 *
 * This module intentionally imports only `@opentelemetry/api`, the tiny,
 * no-op-capable API surface. The shared observability preload owns the Node
 * SDK, providers, exporters, instrumentation, and lifecycle.
 *
 * Application modules (services, loaders, adapters) import these helpers so
 * Vite SSR and browser bundles never pull the SDK into their module graph.
 */

/** True when the current operation has valid OpenTelemetry trace context. */
export function isOpenTelemetryActive(): boolean {
  const traceId = trace.getSpan(context.active())?.spanContext().traceId;
  return Boolean(traceId && traceId !== INVALID_TRACE_ID);
}

/**
 * Returns the trace id of the active span when an SDK is running, otherwise
 * falls back to the supplied id (e.g. the generated webhook request id).
 */
export function getActiveTraceId(fallback: string): string {
  const span = trace.getSpan(context.active());
  const traceId = span?.spanContext().traceId;
  if (traceId && traceId !== INVALID_TRACE_ID) {
    return traceId;
  }
  return fallback;
}

/**
 * Resolves the deployment environment name:
 * `DEPLOYMENT_ENVIRONMENT_NAME` when set, otherwise a conservative fallback
 * derived from NODE_ENV.
 */
export function resolveDeploymentEnvironmentName(): string {
  const configured = envString("DEPLOYMENT_ENVIRONMENT_NAME");
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    return "production";
  }
  if (process.env.NODE_ENV === "test") {
    return "test";
  }
  return "development";
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
