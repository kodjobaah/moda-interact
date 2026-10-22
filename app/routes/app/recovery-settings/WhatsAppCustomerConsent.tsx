/** Merchant guidance only. Shopify owns WhatsApp marketing opt-in and Moda enforces consent at recovery admission. */
export const SHOPIFY_WHATSAPP_CONSENT_GUIDES = {
  checkout: "https://help.shopify.com/en/manual/promoting-marketing/create-marketing/customer-contact-information",
  forms: "https://help.shopify.com/en/manual/promoting-marketing/create-marketing/forms-app/create",
} as const;

type Translate = (key: string) => string;

export default function WhatsAppCustomerConsent({ t }: { t: Translate }) {
  return (
    <section
      className="moda-recovery-panel moda-recovery-consent-panel"
      aria-labelledby="recovery-whatsapp-consent-heading"
    >
      <div className="moda-recovery-panel-heading">
        <div>
          <h2 id="recovery-whatsapp-consent-heading">
            {t("recoverySettings.whatsappConsent.title")}
          </h2>
          <p>{t("recoverySettings.whatsappConsent.marketing")}</p>
        </div>
      </div>
      <div className="moda-recovery-consent-grid">
        <article className="moda-recovery-consent-card">
          <h3>{t("recoverySettings.whatsappConsent.setupTitle")}</h3>
          <p>{t("recoverySettings.whatsappConsent.setup")}</p>
          <a href={SHOPIFY_WHATSAPP_CONSENT_GUIDES.checkout} target="_blank" rel="noopener noreferrer">
            {t("recoverySettings.whatsappConsent.setupLink")}
          </a>
        </article>
        <article className="moda-recovery-consent-card">
          <h3>{t("recoverySettings.whatsappConsent.earlyTitle")}</h3>
          <p>{t("recoverySettings.whatsappConsent.early")}</p>
          <a href={SHOPIFY_WHATSAPP_CONSENT_GUIDES.forms} target="_blank" rel="noopener noreferrer">
            {t("recoverySettings.whatsappConsent.formsLink")}
          </a>
        </article>
        <article className="moda-recovery-consent-card">
          <h3>{t("recoverySettings.whatsappConsent.noConsentTitle")}</h3>
          <p>{t("recoverySettings.whatsappConsent.noConsent")}</p>
          <p>{t("recoverySettings.whatsappConsent.unavailable")}</p>
        </article>
        <article className="moda-recovery-consent-card">
          <h3>{t("recoverySettings.whatsappConsent.laterTitle")}</h3>
          <p>{t("recoverySettings.whatsappConsent.later")}</p>
        </article>
        <article className="moda-recovery-consent-card moda-recovery-consent-stop">
          <h3>{t("recoverySettings.whatsappConsent.stopTitle")}</h3>
          <p>{t("recoverySettings.whatsappConsent.stop")}</p>
        </article>
      </div>
    </section>
  );
}
