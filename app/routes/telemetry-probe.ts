import { createLogger } from "@modainteract/moda-interact-shared/logging";
import {
  isOpenTelemetryActive,
  resolveDeploymentEnvironmentName,
} from "../services/otel/otel.runtime";

/**
 * GET /telemetry-probe — one-shot end-to-end telemetry validation.
 *
 * Exercises every telemetry signal through the app's real pipeline:
 *
 * - a structured log record is emitted while the inbound HTTP server span is
 *   active, so the record is correlated with that span's trace id;
 * - an outbound request is made so the HTTP client instrumentation records a
 *   child span.
 *
 * When the OpenTelemetry SDK is active (the process bootstrap ran and an OTLP
 * endpoint is configured), the log record and both spans are exported to the
 * collector. `TELEMETRY_PROBE_TARGET` overrides the outbound target (defaults
 * to a public, stable URL); integration tests point it at a local collector.
 */
const probeLogger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});

export const loader = async () => {
  const startedAt = Date.now();
  const target =
    process.env.TELEMETRY_PROBE_TARGET ?? "https://admin.shopify.com/";

  let status = "OK";
  let error: string | null = null;

  try {
    const response = await fetch(target);
    if (!response.ok) {
      status = `UNEXPECTED_STATUS_${response.status}`;
    }
  } catch (caught) {
    status = "NETWORK_ERROR";
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const elapsedMs = Date.now() - startedAt;

  // Emitted under the active server span for the probe request. When the
  // OpenTelemetry Logs SDK is installed this record is exported with the
  // active trace id attached.
  probeLogger.info("telemetry.probe", {
    target,
    status,
    error,
    elapsedMs,
  });

  return Response.json(
    {
      otel: {
        active: isOpenTelemetryActive(),
        environment: resolveDeploymentEnvironmentName(),
      },
      probe: { target, status, error, elapsedMs },
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
};
