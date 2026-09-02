import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import { recordShopifyWebhookTelemetry } from "../otel/shopify-webhook-telemetry.server";
import type { ShopifyWebhookObservation } from "./shopify-webhook-observation";

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
