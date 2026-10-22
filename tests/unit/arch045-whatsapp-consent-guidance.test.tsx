import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createMerchantI18n, SUPPORTED_ADMIN_LOCALES, sourceCatalogues } from "../../app/utils/merchant-i18n";
import WhatsAppCustomerConsent, {
  SHOPIFY_WHATSAPP_CONSENT_GUIDES,
} from "../../app/routes/app/recovery-settings/WhatsAppCustomerConsent";

const keys = [
  "title", "marketing", "setupTitle", "setup", "setupLink", "earlyTitle", "early",
  "formsLink", "noConsentTitle", "noConsent", "unavailable", "laterTitle", "later",
  "stopTitle", "stop",
].map((suffix) => `recoverySettings.whatsappConsent.${suffix}`);

function render(locale: string) {
  const i18n = createMerchantI18n({ locale, fallbackLocale: "en", timeZone: "UTC" });
  return renderToStaticMarkup(createElement(WhatsAppCustomerConsent, { t: i18n.t }));
}

describe("ARCH-045 Shopify WhatsApp Customer Consent guidance", () => {
  it("is a discoverable, informational section in Recovery Settings, not a consent control", async () => {
    const view = await readFile(new URL("../../app/routes/app/recovery-settings/RecoverySettingsView.tsx", import.meta.url), "utf8");
    expect(view).toContain('<WhatsAppCustomerConsent t={i18n.t} />');
    expect(view.indexOf('<WhatsAppCustomerConsent t={i18n.t} />')).toBeGreaterThan(view.indexOf('</SettingsForm>'));
    const html = render("en");
    expect(html).toContain('aria-labelledby="recovery-whatsapp-consent-heading"');
    expect(html).toContain('id="recovery-whatsapp-consent-heading"');
    expect(html).toContain("WhatsApp Customer Consent");
    expect(html).not.toMatch(/<(input|form|button|select)\b/i);
  });

  it("links only to established Shopify public documentation with accessible labels", () => {
    const html = render("en");
    expect(html).toContain(`href="${SHOPIFY_WHATSAPP_CONSENT_GUIDES.checkout}"`);
    expect(html).toContain(`href="${SHOPIFY_WHATSAPP_CONSENT_GUIDES.forms}"`);
    expect((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? [])).toHaveLength(2);
    expect(html).toContain("Shopify guide: checkout marketing opt-in");
    expect(html).toContain("Shopify guide: WhatsApp opt-in forms");
  });

  it("does not mistake tracking or a phone number for messaging opt-in, or promise a consent-driven replay", () => {
    const html = render("en");
    expect(html).toContain("marketing messages, not order confirmations or utility updates");
    expect(html).toContain("Collecting a phone number or accepting Shopify Customer Privacy tracking consent is not WhatsApp marketing consent");
    expect(html).toContain("only after checkout submission");
    expect(html).toContain("guest checkout");
    expect(html).toContain("Shopify Forms");
    expect(html).toContain("does not create a CheckoutRecovery");
    expect(html).toContain("charge a recovery credit");
    expect(html).toContain("checkout-keyed notice in Moda Support");
    expect(html).toContain("A verification outage does not mean that the customer declined");
    expect(html).toContain("Only a later normal checkout reconciliation might create a recovery");
    expect(html).toContain("does not impose a 72-hour consent expiry");
    expect(html).toContain("a later Shopify consent grant cannot override this STOP");
    expect(html).not.toContain("DETECTED");
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
      expect(html).toContain(catalogues[locale]["recoverySettings.whatsappConsent.stopTitle"]);
    }
  });
});
