import type { ThemeActivationStatus } from "@/services/shopify-consent/theme-activation-status";
import type { ShopifyConsentPlacement } from "@/services/shopify-consent/theme-activation-url.server";

type Translate = (key: string) => string;

export type WhatsAppConsentActivation = Readonly<{
  placement: ShopifyConsentPlacement;
  cartStatus: ThemeActivationStatus;
  plusStatus: ThemeActivationStatus;
  gateState: "enabled" | "disabled" | "unknown";
  cartThemeEditorUrl: string | null;
  checkoutEditorUrl: string | null;
  appProxyDefaultRoot: string;
}>;

const STATUS_KEYS: Record<ThemeActivationStatus, string> = {
  active: "recoverySettings.whatsappConsent.statusActive",
  inactive: "recoverySettings.whatsappConsent.statusInactive",
  unsupported: "recoverySettings.whatsappConsent.statusUnsupported",
  unavailable: "recoverySettings.whatsappConsent.statusUnavailable",
  unverified: "recoverySettings.whatsappConsent.statusUnverified",
};

export default function WhatsAppCustomerConsent({
  t, activation, plusStatusOverride, onActivate, busy = false,
  actionFailed = false, editorFallbackUrl = null,
}: {
  t: Translate;
  activation: WhatsAppConsentActivation;
  plusStatusOverride?: ThemeActivationStatus;
  onActivate?: () => void;
  busy?: boolean;
  actionFailed?: boolean;
  editorFallbackUrl?: string | null;
}) {
  const isPlus = activation.placement === "plus_checkout";
  const isCart = activation.placement === "non_plus_cart";
  const isKnown = isPlus || isCart;
  const status = isPlus
    ? plusStatusOverride ?? activation.plusStatus
    : isCart ? activation.cartStatus : "unavailable";
  const canActivate = isCart
    ? Boolean(activation.cartThemeEditorUrl)
    : Boolean(activation.checkoutEditorUrl);
  const active = status === "active";
  const statusLabel = isPlus && status === "inactive"
    ? "recoverySettings.whatsappConsent.statusCheckoutInactive"
    : STATUS_KEYS[status];

  return (
    <section className="moda-recovery-panel moda-recovery-consent-panel"
      aria-labelledby="recovery-whatsapp-consent-heading">
      <div className="moda-recovery-panel-heading">
        <div>
          <h2 id="recovery-whatsapp-consent-heading">
            {t("recoverySettings.whatsappConsent.title")}
          </h2>
          <p>{t("recoverySettings.whatsappConsent.marketing")}</p>
        </div>
      </div>
      <div className="moda-recovery-consent-grid">
        {!isKnown ? (
          <article className="moda-recovery-consent-card" data-consent-card="unknown-plan">
            <h3>{t("recoverySettings.whatsappConsent.unknownPlanTitle")}</h3>
            <p>{t("recoverySettings.whatsappConsent.unknownPlan")}</p>
            <p role="status" data-activation-status="unavailable">
              {t("recoverySettings.whatsappConsent.statusUnavailable")}
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              {t("reinstalling.retry")}
            </button>
          </article>
        ) : (
          <article className="moda-recovery-consent-card" data-consent-card={isPlus ? "plus-checkout" : "cart-block"}>
            <h3>{t(isPlus
              ? "recoverySettings.whatsappConsent.plusTitle"
              : "recoverySettings.whatsappConsent.cartTitle")}</h3>
            <p>{t(isPlus
              ? "recoverySettings.whatsappConsent.plusBody"
              : "recoverySettings.whatsappConsent.cartBody")}</p>
            <p role="status" data-activation-status={status}
              className={`moda-recovery-consent-status moda-recovery-consent-status-${status}`}>
              {t(statusLabel)}
            </p>
            {!active && canActivate ? (
              <button className="moda-recovery-consent-action" type="button"
                onClick={onActivate} disabled={busy || !onActivate}>
                {t(busy
                  ? "recoverySettings.whatsappConsent.activationPreparing"
                  : "recoverySettings.whatsappConsent.activationAction")}
              </button>
            ) : null}
            {!active && !canActivate ? (
              <p role="status">{t("recoverySettings.whatsappConsent.statusUnavailable")}</p>
            ) : null}
            {actionFailed ? (
              <p role="alert">{t("recoverySettings.whatsappConsent.activationFailed")}</p>
            ) : null}
            {editorFallbackUrl ? (
              <a href={editorFallbackUrl} target="_blank" rel="noopener noreferrer">
                {t("recoverySettings.whatsappConsent.activationOpenEditor")}
              </a>
            ) : null}
            <p>{t(isPlus
              ? "recoverySettings.whatsappConsent.plusVerify"
              : "recoverySettings.whatsappConsent.cartVerify")}</p>
          </article>
        )}
      </div>
      <details className="moda-recovery-consent-guidance">
        <summary>{t("recoverySettings.whatsappConsent.returningTitle")}</summary>
        <p>{t("recoverySettings.whatsappConsent.returning")}</p>
        <p>{t("recoverySettings.whatsappConsent.stop")}</p>
        {isCart ? <p>{t("recoverySettings.whatsappConsent.proxyBody")}</p> : null}
      </details>
    </section>
  );
}
