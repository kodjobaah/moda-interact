import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";

const logger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});

function validSupportLogShopId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 191
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

function record(event: string, operation: string, shopId: unknown, error: unknown, warn = false, translationId?: string) {
  logBillingBoundaryFailure({ event, operation, stage: operation, error,
    ...(validSupportLogShopId(shopId) ? { shopId } : {}),
    ...(translationId ? { identities: { translationId } } : {}),
  }, warn ? { ...logger, error: logger.warn } : logger);
}

export function recordMerchantSupportReadFailure(shopId: unknown, error: unknown, operation = "read_support_messages"): void {
  record("merchant.support.recovery_action.read.failed", operation, shopId, error);
}
export function recordMerchantSupportAcknowledgementFailure(shopId: unknown, error: unknown): void {
  record("merchant.support.acknowledgement.failed", "acknowledge_messages", shopId, error);
}
export function recordMerchantSupportSendFailure(shopId: unknown, error: unknown): void {
  record("merchant.support.message.send.failed", "compose_message", shopId, error);
}
export function recordMerchantSupportTranslationDispatchFailure(translationId: string, error: unknown): void {
  record("merchant.support.translation.dispatch.failed", "dispatch_translation", null, error, true, translationId);
}
