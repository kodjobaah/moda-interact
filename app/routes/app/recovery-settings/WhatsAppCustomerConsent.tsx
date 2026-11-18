import type { ThemeActivationStatus } from "@/services/shopify-consent/theme-activation-status";
import type { ShopifyConsentPlacement } from "@/services/shopify-consent/theme-activation-url.server";

type Translate = (key: string) => string;

export type WhatsAppConsentActivation = Readonly<{
  placement: ShopifyConsentPlacement;
  cartStatus: ThemeActivationStatus;
  plusStatus: ThemeActivationStatus;
  cartThemeEditorUrl: string | null;
  appProxyDefaultRoot: string;
}>;

const STATUS_KEYS: Record<ThemeActivationStatus, string> = {
  active: "recoverySettings.whatsappConsent.statusActive",
  inactive: "recoverySettings.whatsappConsent.statusInactive",
  unsupported: "recoverySettings.whatsappConsent.statusUnsupported",
  unavailable: "recoverySettings.whatsappConsent.statusUnavailable",
  unverified: "recoverySettings.whatsappConsent.statusUnverified",
};

function StatusBadge({
  status,
  t,
  id,
}: {
  status: ThemeActivationStatus;
  t: Translate;
  id: string;
}) {
  return (
    <p
      id={id}
      className={`moda-recovery-consent-status moda-recovery-consent-status-${status}`}
      data-activation-status={status}
    >
      {t(STATUS_KEYS[status])}
    </p>
  );
}

/**
 * Plan-exclusive Moda consent placement setup. Non-Plus merchants activate the
 * cart App Block (with the S003 app proxy path setting); Plus merchants use
 * only the checkout extension. Exactly one placement is ever offered, and
 * unverifiable states are reported truthfully.
 */
export default function WhatsAppCustomerConsent({
  t,
  activation,
}: {
  t: Translate;
  activation: WhatsAppConsentActivation;
}) {
  const showCart = activation.placement === "non_plus_cart";
  const showPlus = activation.placement === "plus_checkout";

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
        {activation.placement === "unknown" ? (
          <article className="moda-recovery-consent-card" data-consent-card="unknown-plan">
            <h3>{t("recoverySettings.whatsappConsent.unknownPlanTitle")}</h3>
            <p>{t("recoverySettings.whatsappConsent.unknownPlan")}</p>
            <StatusBadge
              status="unavailable"
              t={t}
              id="recovery-whatsapp-consent-plan-status"
            />
          </article>
        ) : null}

        {showPlus ? (
          <article className="moda-recovery-consent-card" data-consent-card="plus-checkout">
            <h3>{t("recoverySettings.whatsappConsent.plusTitle")}</h3>
            <p>{t("recoverySettings.whatsappConsent.plusBody")}</p>
            <p>{t("recoverySettings.whatsappConsent.plusVerify")}</p>
            <StatusBadge
              status={activation.plusStatus}
              t={t}
              id="recovery-whatsapp-consent-plus-status"
            />
          </article>
        ) : null}

        {showCart ? (
          <article className="moda-recovery-consent-card" data-consent-card="cart-block">
            <h3>{t("recoverySettings.whatsappConsent.cartTitle")}</h3>
            <p>{t("recoverySettings.whatsappConsent.cartBody")}</p>
            <p>{t("recoverySettings.whatsappConsent.cartVerify")}</p>
            {activation.cartThemeEditorUrl ? (
              <a
                href={activation.cartThemeEditorUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("recoverySettings.whatsappConsent.cartOpenEditor")}
              </a>
            ) : null}
            <StatusBadge
              status={activation.cartStatus}
              t={t}
              id="recovery-whatsapp-consent-cart-status"
            />
          </article>
        ) : null}

        {showCart ? (
          <article className="moda-recovery-consent-card" data-consent-card="app-proxy">
            <h3>{t("recoverySettings.whatsappConsent.proxyTitle")}</h3>
            <p>{t("recoverySettings.whatsappConsent.proxyBody")}</p>
            <p>
              <code>{activation.appProxyDefaultRoot}</code>
            </p>
            <p>{t("recoverySettings.whatsappConsent.proxyRules")}</p>
          </article>
        ) : null}

        <article className="moda-recovery-consent-card" data-consent-card="returning">
          <h3>{t("recoverySettings.whatsappConsent.returningTitle")}</h3>
          <p>{t("recoverySettings.whatsappConsent.returning")}</p>
        </article>
        <article className="moda-recovery-consent-card" data-consent-card="no-consent">
          <h3>{t("recoverySettings.whatsappConsent.noConsentTitle")}</h3>
          <p>{t("recoverySettings.whatsappConsent.noConsent")}</p>
          <p>{t("recoverySettings.whatsappConsent.unavailable")}</p>
        </article>
        <article className="moda-recovery-consent-card moda-recovery-consent-stop" data-consent-card="stop">
          <h3>{t("recoverySettings.whatsappConsent.stopTitle")}</h3>
          <p>{t("recoverySettings.whatsappConsent.stop")}</p>
        </article>
      </div>
    </section>
  );
}
