import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { LANGUAGES, readVerifiedDefault } from "./onboarding-template-default-source.server";
import { isBrandIndependentText, recoveryTemplateFormat, type RecoveryTemplateFormat } from "./recovery-template-format.server";

/** Exactly the six recovery purposes consumed by Background. */
export const ONBOARDING_TEMPLATE_PURPOSES = [
  "INITIAL_NO_OFFER", "INITIAL_CODE_OFFER", "INITIAL_AUTOMATIC_OFFER",
  "FOLLOW_UP_NO_OFFER", "FOLLOW_UP_CODE_OFFER", "FOLLOW_UP_AUTOMATIC_OFFER",
] as const;
export type OnboardingTemplatePurpose = typeof ONBOARDING_TEMPLATE_PURPOSES[number];

export type AssignmentOutcome =
  | "ASSIGNED" | "ALREADY_ASSIGNED" | "SHOP_INELIGIBLE"
  | "NO_APPROVED_DEFAULT" | "DEFAULT_NOT_APPLICABLE" | "ASSIGNMENT_REVIEW_REQUIRED"
  | "SENDER_CONFIGURATION_UNAVAILABLE" | "OPTIONAL_IMAGE_NOT_CONFIGURED";

export type RecoveryProvisioningContext = Readonly<{
  platform: "SHOPIFY" | "WOOCOMMERCE";
  environment: string;
  readSenderWaba: (tx: Prisma.TransactionClient) => Promise<string>;
}>;

/** Preserve valid shop-specific assignments; inherit only the explicit Admin default. */
export async function assignOnePurpose(
  tx: Prisma.TransactionClient, shopId: string, purpose: OnboardingTemplatePurpose, wabaId: string,
  format: RecoveryTemplateFormat, context: RecoveryProvisioningContext,
): Promise<AssignmentOutcome> {
  // Align lock order with Admin's publishing/activation transactions.
  await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtextextended('moda:common-recovery-activation:v1'::text,0))`;
  await tx.$queryRaw`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${shopId} FOR UPDATE`;
  const shop = await tx.shop.findUnique({
    where: { id: shopId }, select: { id: true, platform: true, status: true, onboardingCompleted: true },
  });
  if (!shop || shop.platform !== context.platform || shop.status !== "ACTIVE" || !shop.onboardingCompleted) {
    return "SHOP_INELIGIBLE";
  }
  await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtextextended(${`${shopId}|${wabaId}|${purpose}`}::text,0))`;

  // Keep the purpose-wide lock: Admin still publishes within the same lock
  // domain and must not race a write to either format.
  const current = await tx.whatsAppTemplateVariant.findMany({
    where: { shopId, purpose, enabled: true, status: "APPROVED" },
    select: { id: true, providerAccountId: true, languageTag: true, metaRegistrationId: true,
      metaRegistration: { select: { componentsSnapshot: true, parameterBindingsSnapshot: true } } },
    take: 401,
  });
  // An unlinked or malformed active variant cannot safely be assigned a slot.
  // Never silently overwrite such a merchant's configuration.
  if (current.length > 400 || current.some(item => item.providerAccountId !== wabaId ||
      !item.metaRegistration || !recoveryTemplateFormat(item.metaRegistration.componentsSnapshot))) {
    return "ASSIGNMENT_REVIEW_REQUIRED";
  }
  const sameFormat = current.filter(item => recoveryTemplateFormat(item.metaRegistration?.componentsSnapshot) === format);
  if (sameFormat.length !== 0) {
    const languages = new Set(sameFormat.map(item => item.languageTag));
    const shapeValid = sameFormat.length === LANGUAGES.length && languages.size === LANGUAGES.length &&
      LANGUAGES.every(language => languages.has(language)) && sameFormat.every(item => item.metaRegistrationId) &&
      (format !== "TEXT" || sameFormat.every(item => isBrandIndependentText(item.metaRegistration?.parameterBindingsSnapshot)));
    if (!shapeValid) return "ASSIGNMENT_REVIEW_REQUIRED";
    const targets = await tx.whatsAppTemplatePublicationTarget.findMany({
      where: { shopId, status: "SUCCEEDED", newVariantId: { in: sameFormat.map(item => item.id) } },
      select: { newVariantId: true, languageTag: true, metaRegistrationId: true },
      take: 201,
    });
    return targets.length <= 200 && sameFormat.every(item => targets.some(target =>
      target.newVariantId === item.id && target.languageTag === item.languageTag &&
      target.metaRegistrationId === item.metaRegistrationId))
      ? "ALREADY_ASSIGNED" : "ASSIGNMENT_REVIEW_REQUIRED";
  }

  const pointer = await tx.whatsAppRecoveryTemplateDefault.findUnique({
    where: { wabaId_purpose_format: { wabaId, purpose, format } },
    select: { id: true, definitionId: true, updatedByAdminId: true, updatedAt: true },
  });
  if (!pointer) return format === "IMAGE" ? "OPTIONAL_IMAGE_NOT_CONFIGURED" : "NO_APPROVED_DEFAULT";
  const source = await readVerifiedDefault(tx, pointer.definitionId, purpose, wabaId, format);
  if (!source) return "DEFAULT_NOT_APPLICABLE";
  await tx.$queryRaw`SELECT "id" FROM "public"."PlatformConfiguration"
    WHERE "environment"=${context.environment} AND "key"='messaging.sender' FOR SHARE`;
  if (await context.readSenderWaba(tx) !== wabaId) return "SENDER_CONFIGURATION_UNAVAILABLE";

  // Do not reactivate historical identities or repair partial assignments.
  // Known history in the other format must not block this independent slot.
  const previous = await tx.whatsAppTemplateVariant.findMany({
    where: { shopId, purpose, providerAccountId: wabaId },
    select: { id: true, metaRegistration: { select: { componentsSnapshot: true } } }, take: 401,
  });
  if (previous.length > 400 || previous.some(item => {
    const previousFormat = recoveryTemplateFormat(item.metaRegistration?.componentsSnapshot);
    return previousFormat === null || previousFormat === format;
  })) return "ASSIGNMENT_REVIEW_REQUIRED";

  // Human follow-up admission requires a SUCCEEDED shop-specific
  // publication target. Retain exact immutable provenance instead of creating
  // free-standing variants that only Background would accept.
  const digest = createHash("sha256").update(JSON.stringify([
    "onboarding-platform-default-v3", context.platform, shopId, purpose, format, wabaId, pointer.id,
    pointer.definitionId, pointer.updatedAt.toISOString(), source.evidenceFingerprint,
  ])).digest("hex");
  const child = await tx.whatsAppTemplatePublicationOperation.create({
    data: {
      definitionId: source.definitionId, requestedByAdminId: pointer.updatedByAdminId,
      operationKey: `onboarding:${digest}`,
      scopeSnapshot: {
        schemaVersion: 1, scope: { mode: "one", shopId }, shopIds: [shopId],
        shopDigests: { [shopId]: digest }, wabaId, purpose, format,
        sourceFingerprint: source.evidenceFingerprint,
        registrationIds: source.registrationIds,
        reason: `Automated onboarding: inherit platform recovery default ${pointer.id}`,
        acknowledgeOverrides: false,
        automatedOnboarding: { source: "PLATFORM_RECOVERY_DEFAULT", format, platform: context.platform, defaultId: pointer.id,
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
    where: { shopId, purpose, providerAccountId: wabaId, enabled: true, status: "APPROVED",
      metaRegistrationId: { in: Object.values(source.registrationIds) } },
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
