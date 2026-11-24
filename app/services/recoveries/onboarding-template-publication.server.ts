import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { LANGUAGES, readVerifiedDefault } from "./onboarding-template-default-source.server";
import { trustedRecoverySenderWaba } from "./recovery-follow-up-sender.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";

/** Exactly the six recovery purposes consumed by Background. */
export const ONBOARDING_TEMPLATE_PURPOSES = [
  "INITIAL_NO_OFFER", "INITIAL_CODE_OFFER", "INITIAL_AUTOMATIC_OFFER",
  "FOLLOW_UP_NO_OFFER", "FOLLOW_UP_CODE_OFFER", "FOLLOW_UP_AUTOMATIC_OFFER",
] as const;
export type OnboardingTemplatePurpose = typeof ONBOARDING_TEMPLATE_PURPOSES[number];

export type AssignmentOutcome =
  | "ASSIGNED" | "ALREADY_ASSIGNED" | "SHOP_INELIGIBLE"
  | "NO_APPROVED_DEFAULT" | "DEFAULT_NOT_APPLICABLE" | "ASSIGNMENT_REVIEW_REQUIRED"
  | "SENDER_CONFIGURATION_UNAVAILABLE";

/** Preserve valid shop-specific assignments; inherit only the explicit Admin default. */
export async function assignOnePurpose(
  tx: Prisma.TransactionClient, shopId: string, purpose: OnboardingTemplatePurpose, wabaId: string,
): Promise<AssignmentOutcome> {
  // Align lock order with Admin's publishing/activation transactions.
  await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtextextended('moda:common-recovery-activation:v1'::text,0))`;
  await tx.$queryRaw`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${shopId} FOR UPDATE`;
  const shop = await tx.shop.findUnique({
    where: { id: shopId }, select: { id: true, platform: true, status: true, onboardingCompleted: true },
  });
  if (!shop || shop.platform !== "SHOPIFY" || shop.status !== "ACTIVE" || !shop.onboardingCompleted) {
    return "SHOP_INELIGIBLE";
  }
  await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtextextended(${`${shopId}|${wabaId}|${purpose}`}::text,0))`;

  const current = await tx.whatsAppTemplateVariant.findMany({
    where: { shopId, purpose, enabled: true, status: "APPROVED" },
    select: { id: true, providerAccountId: true, languageTag: true, metaRegistrationId: true },
  });
  if (current.length !== 0) {
    const languages = new Set(current.map((item) => item.languageTag));
    const shapeValid = current.length === LANGUAGES.length && languages.size === LANGUAGES.length &&
      LANGUAGES.every((language) => languages.has(language)) &&
      current.every((item) => item.providerAccountId === wabaId && item.metaRegistrationId);
    if (!shapeValid) return "ASSIGNMENT_REVIEW_REQUIRED";
    // Human follow-up admission requires durable SUCCEEDED publication targets.
    // A hand-inserted or orphaned 20-locale variant set is not a valid override.
    const targets = await tx.whatsAppTemplatePublicationTarget.findMany({
      where: { shopId, status: "SUCCEEDED", newVariantId: { in: current.map((item) => item.id) } },
      select: { newVariantId: true, languageTag: true, metaRegistrationId: true },
      take: 201,
    });
    return targets.length <= 200 && current.every((item) => targets.some((target) =>
      target.newVariantId === item.id && target.languageTag === item.languageTag &&
      target.metaRegistrationId === item.metaRegistrationId))
      ? "ALREADY_ASSIGNED" : "ASSIGNMENT_REVIEW_REQUIRED";
  }

  const pointer = await tx.whatsAppRecoveryTemplateDefault.findUnique({
    where: { wabaId_purpose: { wabaId, purpose } },
    select: { id: true, definitionId: true, updatedByAdminId: true, updatedAt: true },
  });
  if (!pointer) return "NO_APPROVED_DEFAULT";
  const source = await readVerifiedDefault(tx, pointer.definitionId, purpose, wabaId);
  if (!source) return "DEFAULT_NOT_APPLICABLE";
  // Do not assign a stale sender after the initial provisioning configuration read.
  await tx.$queryRaw`SELECT "id" FROM "public"."PlatformConfiguration"
    WHERE "environment"=${resolveDeploymentEnvironmentName()} AND "key"='messaging.sender' FOR SHARE`;
  if (await trustedRecoverySenderWaba(tx) !== wabaId) return "SENDER_CONFIGURATION_UNAVAILABLE";

  // Newly onboarded shops have no variants. Do not adopt or reactivate a
  // disabled/legacy provider identity; Admin must review such a conflict.
  const previous = await tx.whatsAppTemplateVariant.findMany({
    where: { shopId, purpose, providerAccountId: wabaId },
    select: { id: true }, take: 1,
  });
  if (previous.length) return "ASSIGNMENT_REVIEW_REQUIRED";

  // The Shopify human follow-up reader requires a SUCCEEDED shop-specific
  // publication target. Retain exact immutable provenance instead of creating
  // free-standing variants that only Background would accept.
  const digest = createHash("sha256").update(JSON.stringify([
    "shopify-onboarding-platform-default-v2", shopId, purpose, wabaId, pointer.id,
    pointer.definitionId, pointer.updatedAt.toISOString(), source.evidenceFingerprint,
  ])).digest("hex");
  const child = await tx.whatsAppTemplatePublicationOperation.create({
    data: {
      definitionId: source.definitionId, requestedByAdminId: pointer.updatedByAdminId,
      operationKey: `onboarding:${digest}`,
      scopeSnapshot: {
        schemaVersion: 1, scope: { mode: "one", shopId }, shopIds: [shopId],
        shopDigests: { [shopId]: digest }, wabaId, purpose,
        sourceFingerprint: source.evidenceFingerprint,
        registrationIds: source.registrationIds,
        reason: `Automated onboarding: inherit platform recovery default ${pointer.id}`,
        acknowledgeOverrides: false,
        automatedOnboarding: { source: "PLATFORM_RECOVERY_DEFAULT", defaultId: pointer.id,
          defaultDefinitionId: pointer.definitionId, defaultUpdatedAt: pointer.updatedAt.toISOString(),
          defaultUpdatedByAdminId: pointer.updatedByAdminId, evidenceFingerprint: source.evidenceFingerprint },
      },
      status: "COMPLETE", totalTargets: LANGUAGES.length,
      succeededTargets: LANGUAGES.length, failedTargets: 0, completedAt: new Date(),
    },
    select: { id: true },
  });
  const records = LANGUAGES.map((language) => {
    const registration = source.registrations.find((row) => row.id === source.registrationIds[language])!;
    return { shopId, providerAccountId: wabaId, purpose, languageTag: language,
      providerTemplateName: registration.providerTemplateName,
      providerLanguageCode: registration.providerLanguageCode,
      providerTemplateId: registration.providerTemplateId,
      metaRegistrationId: registration.id, enabled: true, status: "APPROVED" as const };
  });
  await tx.whatsAppTemplateVariant.createMany({ data: records });
  const created = await tx.whatsAppTemplateVariant.findMany({
    where: { shopId, purpose, providerAccountId: wabaId, enabled: true, status: "APPROVED" },
    select: { id: true, languageTag: true, metaRegistrationId: true },
  });
  if (created.length !== LANGUAGES.length ||
      !LANGUAGES.every((language) => created.filter((row) => row.languageTag === language &&
        row.metaRegistrationId === source.registrationIds[language]).length === 1)) {
    throw new Error("Approved onboarding variants did not persist with exact registration identity");
  }
  await tx.whatsAppTemplatePublicationTarget.createMany({
    data: created.map((variant) => ({
      operationId: child.id, shopId, languageTag: variant.languageTag,
      metaRegistrationId: variant.metaRegistrationId!, newVariantId: variant.id,
      status: "SUCCEEDED", processedAt: new Date(),
    })),
  });
  return "ASSIGNED";
}
