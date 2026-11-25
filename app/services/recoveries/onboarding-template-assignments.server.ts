import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createOperationalIncidentReporter,
  createPrismaOperationalIncidentPersistence,
  OPERATIONAL_INCIDENT_CONTRACT_VERSION,
} from "@modainteract/moda-interact-shared/incidents";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../../db.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import { trustedRecoverySenderWaba } from "./recovery-follow-up-sender.server";
import { ONBOARDING_TEMPLATE_PURPOSES, assignOnePurpose } from "./onboarding-template-publication.server";
import { RECOVERY_TEMPLATE_FORMATS } from "./recovery-template-format.server";

export { ONBOARDING_TEMPLATE_PURPOSES } from "./onboarding-template-publication.server";

const logger = createLogger({
  serviceName: "moda-shopify-app", environment: resolveDeploymentEnvironmentName(),
});
const incidentReporter = createOperationalIncidentReporter({
  persistence: createPrismaOperationalIncidentPersistence({ prisma }), logger,
});
type IncidentReporter = Pick<ReturnType<typeof createOperationalIncidentReporter>, "report">;

export function assignmentResolutionInstructions(purpose: string, reason: string): string {
  if (reason === "SENDER_CONFIGURATION_UNAVAILABLE") {
    return "Shopify template provisioning: verify Platform Admin messaging.sender configuration, including the configured WABA; restore a valid sender and retry onboarding.";
  }
  if (reason === "ASSIGNMENT_REVIEW_REQUIRED") {
    return `WhatsApp ${purpose}: existing shop assignments are incomplete or conflict with this WABA. In Platform Admin > System Controls > WhatsApp templates review and re-publish this shop's approved assignment; do not edit SQL.`;
  }
  if (reason === "ASSIGNMENT_TRANSACTION_FAILED") {
    return `WhatsApp ${purpose}: the automatic assignment transaction failed. Check the original server-side error logs and current published variant/target state, resolve the conflict, then retry onboarding.`;
  }
  return `WhatsApp ${purpose}: ${reason}. In Platform Admin > System Controls > WhatsApp templates, verify the correct 20-language Meta-approved recovery definition for the configured WABA, reconcile Meta approval/content status, then open Recovery defaults and use Set as default or Replace default. Retry onboarding after the default is configured.`;
}

/** Non-critical post-commit onboarding step. Both callback and resume call it.
 * Errors never reverse merchant billing/onboarding, but the bounded synchronous
 * reads can add latency; do not claim this work runs in the background. */
export async function ensureOnboardingRecoveryTemplatesBestEffort(
  shopId: string,
  db: PrismaClient = prisma,
  reporter: IncidentReporter = incidentReporter,
): Promise<void> {
  const environment = resolveDeploymentEnvironmentName();
  const report = async (purpose: string, reasonCode: string, error?: unknown, format?: string) => {
    if (error !== undefined) logger.error("shopify.onboarding.template_assignment.failed", {
      shopId, purpose, format, reasonCode, error,
    });
    else logger.warn("shopify.onboarding.template_assignment.unavailable", { shopId, purpose, format, reasonCode });
    const id = format ? `${shopId}:${purpose}:${format}` : `${shopId}:${purpose}`;
    try {
      const result = await reporter.report({
        contractVersion: OPERATIONAL_INCIDENT_CONTRACT_VERSION,
        sourceService: "moda-shopify-app", environment,
        category: "WHATSAPP_TEMPLATE_PROVISIONING", reasonCode, resourceKey: id,
        shopId, severity: "HIGH", occurrenceId: randomUUID(), correlationId: id,
        occurredAt: new Date().toISOString(),
        errorMessage: assignmentResolutionInstructions(format ? `${purpose} ${format}` : purpose, reasonCode).slice(0, 512),
      });
      if (!result) logger.error("shopify.onboarding.template_assignment.incident_failed", { shopId, purpose, format, reasonCode });
    } catch (incidentError) {
      logger.error("shopify.onboarding.template_assignment.incident_failed", {
        shopId, purpose, format, reasonCode, error: incidentError,
      });
    }
  };
  let wabaId: string;
  try {
    wabaId = await trustedRecoverySenderWaba(db);
  } catch (error) {
    await report("SENDER", "SENDER_CONFIGURATION_UNAVAILABLE", error);
    return;
  }
  for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) for (const format of RECOVERY_TEMPLATE_FORMATS) {
    try {
      const outcome = await db.$transaction(
        (tx) => assignOnePurpose(tx, shopId, purpose, wabaId, format, {
          platform: "SHOPIFY", environment, readSenderWaba: trustedRecoverySenderWaba,
        }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 2_000, timeout: 7_000 },
      );
      logger.info("shopify.onboarding.template_assignment.outcome", { shopId, purpose, format, outcome });
      if (!["ASSIGNED", "ALREADY_ASSIGNED", "SHOP_INELIGIBLE", "OPTIONAL_IMAGE_NOT_CONFIGURED"].includes(outcome)) {
        await report(purpose, outcome, undefined, format);
      }
    } catch (error) {
      await report(purpose, "ASSIGNMENT_TRANSACTION_FAILED", error, format);
    }
  }
}
