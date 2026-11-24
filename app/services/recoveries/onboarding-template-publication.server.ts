import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";
import { providerComponentsHash } from "./recovery-template-provider-hash.server";

/** Exactly the six recovery purposes consumed by Background. The Meta-approved
 * Admin publication (scope=all, COMPLETE) is the default for FUTURE shops.
 * A one-shop publication is an override, never a global default. */
export const ONBOARDING_TEMPLATE_PURPOSES = [
  "INITIAL_NO_OFFER", "INITIAL_CODE_OFFER", "INITIAL_AUTOMATIC_OFFER",
  "FOLLOW_UP_NO_OFFER", "FOLLOW_UP_CODE_OFFER", "FOLLOW_UP_AUTOMATIC_OFFER",
] as const;
export type OnboardingTemplatePurpose = typeof ONBOARDING_TEMPLATE_PURPOSES[number];

export type AssignmentOutcome =
  | "ASSIGNED" | "ALREADY_ASSIGNED" | "SHOP_INELIGIBLE"
  | "NO_APPROVED_DEFAULT" | "DEFAULT_NOT_APPLICABLE" | "ASSIGNMENT_REVIEW_REQUIRED";

type PublicationSnapshot = {
  schemaVersion: 1;
  scope: { mode: "all" };
  wabaId: string;
  purpose: string;
  registrationIds: Record<string, string>;
  sourceFingerprint: string;
  previewFingerprint: string;
};

const LANGUAGES: readonly string[] = MODA_SUPPORTED_LANGUAGE_TAGS;

function expectedSnapshot(value: unknown, purpose: string, wabaId: string): PublicationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const scope = row.scope;
  const registrationIds = row.registrationIds;
  if (row.schemaVersion !== 1 || row.wabaId !== wabaId || row.purpose !== purpose ||
      typeof row.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.sourceFingerprint) ||
      typeof row.previewFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.previewFingerprint) ||
      !scope || typeof scope !== "object" || Array.isArray(scope) ||
      (scope as { mode?: unknown }).mode !== "all" ||
      !registrationIds || typeof registrationIds !== "object" || Array.isArray(registrationIds)) return null;
  const ids = registrationIds as Record<string, unknown>;
  if (Object.keys(ids).length !== LANGUAGES.length ||
      !LANGUAGES.every((language) => typeof ids[language] === "string" && (ids[language] as string).length > 0) ||
      new Set(Object.values(ids)).size !== LANGUAGES.length) return null;
  return row as unknown as PublicationSnapshot;
}


function validApprovedLocale(reg: {
  id: string;
  wabaId: string;
  providerTemplateName: string;
  providerLanguageCode: string;
  providerTemplateId: string | null;
  providerStatus: string | null;
  submissionState: string;
  lastReconciledAt: Date | null;
  failureCode: string | null;
  driftDetectedAt: Date | null;
  category: string;
  lastObservedCategory: string | null;
  lastObservedContentHash: string | null;
  submittedContentHash: string;
  componentsSnapshot: unknown;
  parameterBindingsSnapshot: unknown;
  locale: {
    definitionId: string;
    status: string;
    languageTag: string;
    providerLanguageCode: string | null;
    contentHash: string | null;
    reviewedAt: Date | null;
    reviewedByAdminId: string | null;
  };
}, input: { definitionId: string; wabaId: string; language: string }): boolean {
  const bindings = reg.parameterBindingsSnapshot;
  const promotionTarget = bindings && typeof bindings === "object" && !Array.isArray(bindings)
    ? (bindings as Record<string, unknown>).promotionTarget : undefined;
  return reg.wabaId === input.wabaId && reg.locale.definitionId === input.definitionId &&
    reg.locale.languageTag === input.language &&
    reg.providerStatus === "APPROVED" &&
    ["SUBMITTED", "CONFIRMED", "APPROVED"].includes(reg.submissionState) &&
    Boolean(reg.providerTemplateId && reg.providerTemplateName && reg.providerLanguageCode) &&
    reg.providerLanguageCode === reg.locale.providerLanguageCode &&
    reg.category === "MARKETING" && !reg.failureCode && !reg.driftDetectedAt &&
    reg.lastObservedCategory === "MARKETING" &&
    reg.lastObservedContentHash === providerComponentsHash(reg.componentsSnapshot) &&
    reg.lastReconciledAt instanceof Date && Number.isFinite(reg.lastReconciledAt.getTime()) &&
    Boolean(reg.locale.contentHash && /^[a-f0-9]{64}$/.test(reg.submittedContentHash) &&
      reg.submittedContentHash === reg.locale.contentHash) &&
    reg.locale.status === "REVIEWED" &&
    (input.language === "en" || Boolean(reg.locale.reviewedAt && reg.locale.reviewedByAdminId)) &&
    promotionTarget !== "ALTERNATIVE_PRODUCT";
}

/** A fully approved cohort is the only default. New or superseding saved
 * versions do not silently replace a completed all-shop publication. */
export async function assignOnePurpose(
  tx: Prisma.TransactionClient, shopId: string, purpose: OnboardingTemplatePurpose, wabaId: string,
): Promise<AssignmentOutcome> {
  // Align lock order with Admin's publishing/activation transactions.
  await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtextextended('moda:common-recovery-activation:v1'::text,0))`;
  const shop = await tx.shop.findUnique({
    where: { id: shopId }, select: { id: true, platform: true, status: true, onboardingCompleted: true },
  });
  if (!shop || shop.platform !== "SHOPIFY" || shop.status !== "ACTIVE" || !shop.onboardingCompleted) {
    return "SHOP_INELIGIBLE";
  }
  await tx.$queryRaw`SELECT "id" FROM "commerce"."Shop" WHERE "id"=${shopId} FOR UPDATE`;
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

  const operation = await tx.whatsAppTemplatePublicationOperation.findFirst({
    where: { status: "COMPLETE", AND: [
      { scopeSnapshot: { path: ["scope", "mode"], equals: "all" } },
      { scopeSnapshot: { path: ["purpose"], equals: purpose } },
      { scopeSnapshot: { path: ["wabaId"], equals: wabaId } },
      { scopeSnapshot: { path: ["schemaVersion"], equals: 1 } },
    ] },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    select: { id: true, definitionId: true, requestedByAdminId: true, scopeSnapshot: true, totalTargets: true,
      succeededTargets: true, failedTargets: true, completedAt: true },
  });
  if (!operation) return "NO_APPROVED_DEFAULT";
  const snapshot = expectedSnapshot(operation.scopeSnapshot, purpose, wabaId);
  if (!snapshot || !operation.completedAt || !operation.totalTargets ||
      operation.succeededTargets !== operation.totalTargets || operation.failedTargets !== 0) {
    return "DEFAULT_NOT_APPLICABLE";
  }
  const definition = await tx.whatsAppTemplateDefinition.findUnique({
    where: { id: operation.definitionId },
    select: { id: true, kind: true, purpose: true, offerType: true, status: true,
      providerTemplateName: true, publishedAt: true, retiredAt: true, category: true },
  });
  if (!definition || definition.kind !== "META_RECOVERY" ||
      definition.status !== "PUBLISHED" || !definition.publishedAt || definition.retiredAt ||
      definition.category !== "MARKETING" || !definition.providerTemplateName ||
      `${definition.purpose}_${definition.offerType}` !== purpose) return "DEFAULT_NOT_APPLICABLE";

  const registrations = await tx.whatsAppTemplateMetaRegistration.findMany({
    where: { id: { in: Object.values(snapshot.registrationIds) } },
    select: {
      id: true, wabaId: true, providerTemplateName: true, providerLanguageCode: true,
      providerTemplateId: true, providerStatus: true, submissionState: true, lastReconciledAt: true,
      failureCode: true, driftDetectedAt: true, category: true,
      lastObservedCategory: true, lastObservedContentHash: true,
      submittedContentHash: true, componentsSnapshot: true, parameterBindingsSnapshot: true,
      locale: { select: { definitionId: true, status: true, languageTag: true, providerLanguageCode: true,
        contentHash: true, reviewedAt: true, reviewedByAdminId: true } },
    },
  });
  if (registrations.length !== LANGUAGES.length ||
      !LANGUAGES.every((language) => {
        const registration = registrations.find((row) => row.id === snapshot.registrationIds[language]);
        return Boolean(registration && registration.providerTemplateName === definition.providerTemplateName &&
          validApprovedLocale(registration, { definitionId: definition.id, wabaId, language }));
      })) return "DEFAULT_NOT_APPLICABLE";

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
    "shopify-onboarding-template-publication-v1", shopId, purpose, wabaId, operation.id,
  ])).digest("hex");
  const child = await tx.whatsAppTemplatePublicationOperation.create({
    data: {
      definitionId: definition.id, requestedByAdminId: operation.requestedByAdminId,
      operationKey: `onboarding:${digest}`,
      scopeSnapshot: {
        schemaVersion: 1, scope: { mode: "one", shopId }, shopIds: [shopId],
        shopDigests: { [shopId]: digest }, wabaId, purpose,
        sourceFingerprint: snapshot.sourceFingerprint,
        previewFingerprint: snapshot.previewFingerprint,
        registrationIds: snapshot.registrationIds,
        reason: `Automated onboarding: inherit completed all-shop publication ${operation.id}`,
        acknowledgeOverrides: false,
        automatedOnboarding: { sourcePublicationOperationId: operation.id },
      },
      status: "COMPLETE", totalTargets: LANGUAGES.length,
      succeededTargets: LANGUAGES.length, failedTargets: 0, completedAt: new Date(),
    },
    select: { id: true },
  });
  const records = LANGUAGES.map((language) => {
    const registration = registrations.find((row) => row.id === snapshot.registrationIds[language])!;
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
        row.metaRegistrationId === snapshot.registrationIds[language]).length === 1)) {
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
