import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createMerchantI18n, SUPPORTED_ADMIN_LOCALES, sourceCatalogues } from "../../app/utils/merchant-i18n";
import WhatsAppCustomerConsent, {
  type WhatsAppConsentActivation,
} from "../../app/routes/app/recovery-settings/WhatsAppCustomerConsent";

const keys = [
  "title", "marketing", "noConsentTitle", "noConsent", "unavailable",
  "stopTitle", "stop",
  "plusTitle", "plusBody", "plusVerify",
  "cartTitle", "cartBody", "cartActiveTitle", "cartActiveBody", "cartVerify", "cartOpenEditor",
  "proxyTitle", "proxyBody", "proxyRules",
  "returningTitle", "returning",
  "unknownPlanTitle", "unknownPlan",
  "statusActive", "statusInactive", "statusUnsupported",
  "statusUnavailable", "statusUnverified",
  "activationAction", "activationRestore", "activationPreparing", "activationFailed",
  "activationOpenEditor", "statusCheckoutInactive",
].map((suffix) => `recoverySettings.whatsappConsent.${suffix}`);

const nonPlusActivation: WhatsAppConsentActivation = {
  placement: "non_plus_cart",
  cartStatus: "inactive",
  plusStatus: "unsupported",
  gateState: "disabled",
  setupPhase: "never",
  checkoutEditorUrl: null,
  cartThemeEditorUrl:
    "https://merchant.myshopify.com/admin/themes/current/editor?template=cart",
  appProxyDefaultRoot: "/apps/moda-consent",
};

function render(locale: string, activation: WhatsAppConsentActivation = nonPlusActivation) {
  const i18n = createMerchantI18n({ locale, fallbackLocale: "en", timeZone: "UTC" });
  return renderToStaticMarkup(
    createElement(WhatsAppCustomerConsent, { t: i18n.t, activation }),
  );
}

describe("WhatsApp Customer Consent guidance (ARCH-045, superseded placement setup by ARCH-077 S005)", () => {
  it("is a discoverable, informational section in Recovery Settings, not a consent control", async () => {
    const view = await readFile(new URL("../../app/routes/app/recovery-settings/RecoverySettingsView.tsx", import.meta.url), "utf8");
    expect(view).toContain("<WhatsAppConsentActivationController t={i18n.t} activation={data.whatsappActivation} />");
    expect(view.indexOf("<WhatsAppConsentActivationController")).toBeGreaterThan(view.indexOf("</SettingsForm>"));
    const html = render("en");
    expect(html).toContain('aria-labelledby="recovery-whatsapp-consent-heading"');
    expect(html).toContain('id="recovery-whatsapp-consent-heading"');
    expect(html).toContain("WhatsApp Customer Consent");
    expect(html).not.toMatch(/<(input|form|select)\b/i);
    expect(html).toContain('data-consent-card="cart-block"');
    expect(html).toContain("Activate WhatsApp Consent");
    expect((html.match(/<button\b/g) ?? []).length).toBe(1);
  });

  it("replaces Shopify-native WhatsApp opt-in instructions with Moda placement activation", () => {
    const html = render("en");
    expect(html).not.toContain("help.shopify.com");
    expect(html).toContain("theme editor");
    expect(html).toContain("Activate WhatsApp Consent");
    // The destination is returned only after an authenticated activation POST.
    expect(html).not.toContain('href="https://merchant.myshopify.com/admin/themes/current/editor?template=cart"');
    expect(html).not.toContain('data-consent-card="plus-checkout"');
  });

  it("does not mistake tracking or a phone number for messaging opt-in, and keeps STOP authoritative", () => {
    const html = render("en");
    expect(html).toContain("marketing messages, not order confirmations or utility updates");
    expect(html).toContain("Collecting a phone number or accepting Shopify Customer Privacy tracking consent is not WhatsApp marketing consent");
    expect(html).toContain("a later Shopify consent grant cannot override this STOP");
    expect(html).toContain("without writing anything");
    expect(html).toContain("reminders always follow the permission stored at send time");
    expect(html).not.toContain("consent-triggered retry");
  });

  it("fully translates every guidance key in all 20 merchant locales without English fallback", () => {
    expect(SUPPORTED_ADMIN_LOCALES).toHaveLength(20);
    const catalogues = sourceCatalogues as Record<string, Record<string, string>>;
    for (const locale of SUPPORTED_ADMIN_LOCALES) {
      for (const key of keys) {
        expect(typeof catalogues[locale][key], `${locale}: ${key}`).toBe("string");
        expect(catalogues[locale][key].trim().length).toBeGreaterThan(0);
        if (locale !== "en") {
          expect(catalogues[locale][key], `${locale}: ${key} untranslated`).not.toBe(catalogues.en[key]);
        }
      }
      const html = render(locale);
      expect(html).toContain(catalogues[locale]["recoverySettings.whatsappConsent.title"]);
      const activeHtml = render(locale, { ...nonPlusActivation,
        cartStatus: "active", cartBlockPresence: "enabled", gateState: "enabled", setupPhase: "active" });
      expect(activeHtml).toContain(catalogues[locale]["recoverySettings.whatsappConsent.cartActiveTitle"]);
      expect(activeHtml).toContain(catalogues[locale]["recoverySettings.whatsappConsent.cartActiveBody"]);
      // The compact S005 panel renders STOP guidance inside a details section,
      // not the legacy standalone STOP heading. React escapes apostrophes in text.
      expect(html.replaceAll("&#x27;", "'")).toContain(
        catalogues[locale]["recoverySettings.whatsappConsent.stop"],
      );
    }
  });
});
