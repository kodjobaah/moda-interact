import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";
import { ShopifyPlatformConfigurationError } from "../platform-configuration/contracts.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";

const logger = createLogger({ serviceName: "moda-interact", environment: resolveDeploymentEnvironmentName() });

/** Semantic recovery boundary; serialization, redaction and sink isolation stay shared. */
export function recordRecoveryFailure(operation: string, shopId: string | undefined, error: unknown, warn = false, recoveryId?: string): void {
  const source = error instanceof ShopifyPlatformConfigurationError
    && error.code === "DATABASE_UNAVAILABLE" && error.cause !== undefined ? error.cause : error;
  logBillingBoundaryFailure({
    event: "shopify.recovery.operation_failed", operation, stage: operation, error: source,
    ...(operation === "command_configuration" ? { origin: "internal" as const } : {}),
    ...(recoveryId && /^[A-Za-z0-9_-]{1,191}$/u.test(recoveryId) ? { identities: { recoveryId } } : {}),
    ...(shopId && /^[A-Za-z0-9_-]{1,191}$/u.test(shopId) ? { shopId } : {}),
  }, warn ? { ...logger, error: logger.warn } : logger);
}
