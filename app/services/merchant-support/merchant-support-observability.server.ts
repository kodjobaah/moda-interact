import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";

const logger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});

function validSupportLogShopId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 191
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

export function recordMerchantSupportReadFailure(shopId: unknown, error: unknown): void {
  logger.error("merchant.support.recovery_action.read.failed", {
    ...(validSupportLogShopId(shopId) ? { shopId } : {}),
    operation: "read_support_messages",
    errorCategory: "database_read_failed",
    error,
  });
}

export function recordMerchantSupportSendFailure(shopId: unknown, error: unknown): void {
  logger.error("merchant.support.message.send.failed", {
    ...(validSupportLogShopId(shopId) ? { shopId } : {}),
    operation: "compose_message",
    errorCategory: "send_failed",
    error,
  });
}

export function recordMerchantSupportTranslationDispatchFailure(translationId: string, error: unknown): void {
  logger.warn("merchant.support.translation.dispatch.failed", {
    translationId: translationId.slice(0, 128),
    errorCategory: "queue_dispatch_failed",
    error,
  });
}
