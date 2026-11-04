import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";

const logger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});
export function recordMerchantSettingsFailure(
  boundary: "read" | "save" | "category",
  operation: string,
  shopId: string,
  error: unknown,
  diagnosticLogger: StructuredLogger = logger,
) {
  logBillingBoundaryFailure(
    {
      event: "merchant.settings." + boundary + ".failed",
      operation,
      stage: operation,
      shopId,
      error,
    },
    diagnosticLogger,
  );
}
