/** A Moda-authored, explicitly published, provider-approved recovery template.
 * Deliberately includes full registration/definition identity for forged-row tests.
 */
export const WABA = "1234567890";
export const validFollowUpVariant = {
  id: "variant-1", shopId: "shop-1", providerAccountId: WABA,
  purpose: "FOLLOW_UP_NO_OFFER", languageTag: "en", providerLanguageCode: "en",
  providerTemplateName: "recovery_reminder", providerTemplateId: "meta-template-1",
  metaRegistrationId: "registration-1", status: "APPROVED", enabled: true,
  metaRegistration: {
    id: "registration-1", wabaId: WABA, providerTemplateName: "recovery_reminder",
    providerLanguageCode: "en", providerTemplateId: "meta-template-1", providerStatus: "APPROVED",
    submissionState: "APPROVED", category: "MARKETING", failureCode: null,
    submittedContentHash: "c".repeat(64), lastObservedContentHash: "c".repeat(64),
    lastObservedCategory: "MARKETING", driftDetectedAt: null,
    locale: { languageTag: "en", providerLanguageCode: "en", status: "REVIEWED",
      contentHash: "c".repeat(64), definition: {
        kind: "META_RECOVERY", purpose: "FOLLOW_UP", offerType: "NO_OFFER", sourceLanguageTag: "en",
        providerTemplateName: "recovery_reminder", category: "MARKETING",
        status: "PUBLISHED", publishedAt: new Date("2026-10-25T10:00:00.000Z"), retiredAt: null,
      } },
  },
};
