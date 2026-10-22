import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const [
  appShellSource,
  supportRouteSource,
  navigationSource,
  routeConfigSource,
  merchantKnowledgeSource,
  recoverySettingsSource,
  featurePreferencesSource,
  reinstallingSource,
] = await Promise.all([
  readFile(new URL("../../app/routes/app/route.jsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/routes/app/merchant-support/route.jsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/components/dashboard/MerchantNavigation.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/routes.ts", import.meta.url), "utf8"),
  readFile(new URL("../../app/components/settings/MerchantKnowledgeSection.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/routes/app/recovery-settings/RecoverySettingsView.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/components/settings/FeaturePreferences.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/routes/app/reinstalling/route.jsx", import.meta.url), "utf8"),
]);

describe("authenticated Shopify UI internationalisation coverage", () => {
  it("localizes the shell and all scoped support controls through existing keys", () => {
    expect(appShellSource).toContain('alt={i18n.t("common.logoAlt")}');
    expect(appShellSource).toContain("merchantUi: merchantUiContext(shop, session)");
    expect(appShellSource).toContain("<MerchantNavigation");
    expect(appShellSource).toContain("<Outlet />");

    for (const key of [
      "support.thread",
      "support.empty",
      "support.paginationLabel",
      "support.previous",
      "support.next",
      "support.contactHeading",
      "support.messageLabel",
      "support.sending",
      "support.send",
      "support.you",
      "support.system",
      "support.modaSupport",
      "support.translationUnavailable",
      "support.translationProcessing",
      "support.viewTranslation",
      "support.viewOriginal",
      "support.sendFailed",
      "support.unsupportedAction",
    ]) {
      expect(supportRouteSource).toContain(`i18n.t("${key}")`);
    }
    expect(supportRouteSource).toContain('i18n.formatNumber(support.page)');
    expect(supportRouteSource).toContain('i18n.formatNumber(support.totalPages)');
    expect(supportRouteSource).toContain('{i18n.formatNumber(graphemeCount)}/{i18n.formatNumber(500)}');
    expect(supportRouteSource).toContain('i18n.t("support.messageLengthError", { max: 500 })');
    expect(supportRouteSource).toContain('<s-page heading={i18n.t("merchantNav.support")}>');
    expect(supportRouteSource).toContain('<p dir="auto">');
    expect(navigationSource).toContain('support: "merchantNav.support"');
    expect(routeConfigSource).toContain('route("merchant-support", "./routes/app/merchant-support/route.jsx")');
  });

  it("keeps the scoped routes free of the retired merchant-facing English literals", () => {
    for (const literal of [
      "Moda Interact logo",
      "Support thread",
      "No messages yet.",
      "Support thread pages",
      "Previous",
      "Next",
      "Page {page} of {totalPages}",
      "Contact Moda Support",
      "Message",
      "Message must contain between 1 and 500 graphemes.",
      "Sending...",
      "Send",
      "You",
      "System",
      "Moda Support",
      "Translation unavailable. Please try again later.",
      "Translation is processing.",
      "View translation",
      "View original",
      "Unable to send message. Please try again.",
      "That support action is not available.",
      "Unsupported merchant support action.",
    ]) {
      expect(appShellSource).not.toContain(`"${literal}"`);
      expect(appShellSource).not.toContain(`>${literal}<`);
      expect(supportRouteSource).not.toContain(`"${literal}"`);
      expect(supportRouteSource).not.toContain(`>${literal}<`);
    }
    expect(supportRouteSource).not.toContain("error.message");
  });

  it("localizes Merchant Knowledge, recovery context, feature copy, and reinstalling UI", () => {
    for (const key of [
      "merchantKnowledge.title",
      "merchantKnowledge.description",
      "merchantKnowledge.configurationUnavailable",
      "merchantKnowledge.disabledNotice",
      "merchantKnowledge.sourceCount",
      "merchantKnowledge.addWebPage",
      "merchantKnowledge.url",
      "merchantKnowledge.noWebPageTypes",
      "merchantKnowledge.empty",
      "merchantKnowledge.noUrl",
      "merchantKnowledge.processingNote",
      "merchantKnowledge.activeContentUnits",
      "merchantKnowledge.truncated",
      "merchantKnowledge.lastProcessed",
      "merchantKnowledge.status.processingPaused",
      "merchantKnowledge.status.unavailableOnPlan",
      "merchantKnowledge.status.sourceTypeUnavailable",
      "merchantKnowledge.status.overSourceLimit",
      "merchantKnowledge.status.ready",
      "merchantKnowledge.status.failed",
      "merchantKnowledge.status.superseded",
      "merchantKnowledge.actions.moveUp",
      "merchantKnowledge.actions.moveDown",
      "merchantKnowledge.actions.delete",
    ]) {
      expect(merchantKnowledgeSource).toContain(`t("${key}"`);
    }
    expect(merchantKnowledgeSource).toContain('t("pending.activeStatus")');
    expect(merchantKnowledgeSource).toContain('t("pending.refresh")');
    expect(merchantKnowledgeSource).toContain('formatDateTime(source.revision.activeFetchedAt)');

    for (const key of [
      "recoverySettings.context.title",
      "recoverySettings.context.description",
      "merchantKnowledge.title",
      "merchantKnowledge.sourceCount",
    ]) {
      expect(recoverySettingsSource).toContain(`i18n.t("${key}"`);
    }
    expect(recoverySettingsSource).toContain('formatDateTime={i18n.formatDateTime}');

    expect(featurePreferencesSource).toContain('merchantFeatures.features.checkout_recovery.name');
    expect(featurePreferencesSource).toContain('merchantFeatures.features.ai_conversations.name');
    expect(featurePreferencesSource).toContain('merchantFeatures.features.product_search.name');
    expect(featurePreferencesSource).toContain('merchantFeatures.features.order_support.name');
    expect(featurePreferencesSource).toContain('merchant_knowledge: {');
    expect(featurePreferencesSource).toContain('name: "merchantKnowledge.title"');

    for (const key of [
      "reinstalling.pendingTitle",
      "reinstalling.pendingDescription",
      "reinstalling.failedTitle",
      "reinstalling.failedDescription",
      "reinstalling.retry",
      "reinstalling.contactSupport",
    ]) {
      expect(reinstallingSource).toContain(`i18n.t("${key}")`);
    }
    expect(reinstallingSource).toContain("merchantUiContext(shop, session)");

    for (const literal of [
      "Store & assistant context",
      "Store classification and reference material used by the assistant.",
      "Configure web pages the assistant can use as reference material.",
      "Merchant Knowledge configuration is unavailable on the current plan.",
      "No knowledge sources configured.",
      "No URL recorded",
      "This page updates automatically while the source is processing.",
      "Move source up",
      "Move source down",
      "Restoring your Moda Interact account",
      "We could not restore your Moda Interact account",
      "Retry restoration or contact support if the problem continues.",
    ]) {
      expect(merchantKnowledgeSource).not.toContain(literal);
      expect(recoverySettingsSource).not.toContain(literal);
      expect(reinstallingSource).not.toContain(literal);
    }
  });

});

// ARCH-040-SHOPIFY-004: These Recovery Detail labels must never silently inherit
// the English source copy in any of the 19 non-English merchant catalogues.
// Only this reviewed set is checked for English identity; proper names and
// technical tokens elsewhere may legitimately be language-neutral.
const recoveryDetailSecondaryCopyKeys = [
  "recoveryDetail.savedSnapshot",
  "recoveryDetail.basketUnavailable",
  "recoveryDetail.basketPartial",
  "recoveryDetail.emptyBasket",
  "recoveryDetail.humanControls",
  "recoveryDetail.windowOpen",
  "recoveryDetail.terminal",
  "recoveryDetail.staleRevision",
  "recoveryDetail.controlFailed",
  "recoveryDetail.latestReply",
  "recoveryDetail.templateUnavailable",
  "recoveryDetail.followUpTemplate",
  "recoveryDetail.customerFlagged",
  "recoveryDetail.sendStatus.CLAIMED",
  "recoveryDetail.sendStatus.DISPATCH_ADMITTED",
  "recoveryDetail.sendStatus.CANCELLED",
] as const;

const merchantLocales = [
  "en", "cs", "da", "de", "es", "fi", "fr", "it", "ja", "ko",
  "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
] as const;

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/\{[a-zA-Z][a-zA-Z0-9_.]*\}/g)]
    .map(([token]) => token)
    .sort();
}

describe("ARCH-040 Recovery Detail merchant locale parity", () => {
  it("translates the 16 secondary-copy keys in every non-English locale without changing delivery meaning", async () => {
    const catalogues = await Promise.all(merchantLocales.map(async (locale) => {
      const content = await readFile(
        new URL(`../../app/i18n/locales/${locale}.json`, import.meta.url), "utf8",
      );
      return [locale, JSON.parse(content) as Record<string, string>] as const;
    }));
    const english = catalogues[0][1];
    const sourceKeys = Object.keys(english).sort();
    expect(recoveryDetailSecondaryCopyKeys).toHaveLength(16);
    expect(catalogues).toHaveLength(20);

    for (const [locale, dictionary] of catalogues) {
      expect(Object.keys(dictionary).sort(), `${locale}: catalogue keys`).toEqual(sourceKeys);
      for (const key of recoveryDetailSecondaryCopyKeys) {
        expect(dictionary[key], `${locale}: ${key} must exist`).toBeTruthy();
        expect(interpolationTokens(dictionary[key]), `${locale}: ${key} interpolation`).toEqual(
          interpolationTokens(english[key]),
        );
        if (locale !== "en") {
          expect(dictionary[key], `${locale}: ${key} remains an English placeholder`).not.toBe(english[key]);
        }
      }
      // Queue acceptance, provider admission, no-send and confirmed send must
      // be distinct labels. Translation may not imply delivery at admission.
      expect(new Set([
        dictionary["recoveryDetail.sendStatus.CLAIMED"],
        dictionary["recoveryDetail.sendStatus.DISPATCH_ADMITTED"],
        dictionary["recoveryDetail.sendStatus.CANCELLED"],
        dictionary["recoveryDetail.sendStatus.SENT"],
        dictionary["recoveryDetail.sendStatus.DELIVERED"],
      ]).size, `${locale}: distinct outbound states`).toBe(5);
    }
  });
});
