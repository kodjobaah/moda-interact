import type { CartConsentBlockPresence, CartConsentSetupPhase, ThemeActivationStatus }
  from "@/services/shopify-consent/theme-activation-status";
import type { ShopifyConsentPlacement } from "@/services/shopify-consent/theme-activation-url.server";

type Translate = (key: string) => string;

export type WhatsAppConsentActivation = Readonly<{
  placement: ShopifyConsentPlacement;
  cartStatus: ThemeActivationStatus;
  cartBlockPresence?: CartConsentBlockPresence;
  plusStatus: ThemeActivationStatus;
  gateState: "enabled" | "disabled" | "unknown";
  setupPhase?: CartConsentSetupPhase;
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

type CartPrimaryAction = Readonly<{ key: string; needsPreparation: boolean }>;
/** Pure UI state machine; neither a prior click nor an editor URL means Active. */
export function getCartPrimaryAction(
  activation: WhatsAppConsentActivation,
): CartPrimaryAction {
  const presence = activation.cartBlockPresence ?? "unknown";
  if (presence === "duplicate") {
    return { key: "activationResolveDuplicates", needsPreparation: false };
  }
  if (activation.cartStatus === "active") {
    return { key: "activationManage", needsPreparation: false };
  }
  if (presence === "disabled" || presence === "enabled") {
    return { key: "activationEnable", needsPreparation: false };
  }
  if (activation.setupPhase === "active" && presence === "absent" &&
      activation.gateState === "enabled") {
    return { key: "activationRestore", needsPreparation: true };
  }
  if (activation.setupPhase === "never" &&
      (activation.gateState === "disabled" ||
       activation.gateState === "enabled" && presence === "absent")) {
    return { key: "activationAction", needsPreparation: true };
  }
  if (activation.gateState === "disabled" && activation.setupPhase !== "unknown") {
    // Recover from a partially completed gate write without inserting a copy.
    return { key: "activationContinue", needsPreparation: true };
  }
  return { key: "activationContinue", needsPreparation: false };
}

export default function WhatsAppCustomerConsent({
  t, activation, plusStatusOverride, onActivate, busy = false, preparing = false,
  actionFailed = false, verificationFailed = false, editorFallbackUrl = null,
}: {
  t: Translate;
  activation: WhatsAppConsentActivation;
  plusStatusOverride?: ThemeActivationStatus;
  onActivate?: () => void;
  busy?: boolean;
  preparing?: boolean;
  actionFailed?: boolean;
  verificationFailed?: boolean;
  editorFallbackUrl?: string | null;
}) {
  const isPlus = activation.placement === "plus_checkout";
  const isCart = activation.placement === "non_plus_cart";
  const isKnown = isPlus || isCart;
  const status = isPlus
    ? plusStatusOverride ?? activation.plusStatus
    : isCart ? activation.cartStatus : "unavailable";
  const cartAction = getCartPrimaryAction(activation);
  const cartPresence = activation.cartBlockPresence ?? "unknown";
  const cartStatusKey = cartPresence === "duplicate"
    ? "recoverySettings.whatsappConsent.statusDuplicate"
    : status === "inactive" && cartPresence === "absent"
      ? "recoverySettings.whatsappConsent.statusMissing"
      : status === "inactive" && cartPresence === "disabled"
        ? "recoverySettings.whatsappConsent.statusDisabled"
        : STATUS_KEYS[status];
  const statusKey = isPlus && status === "inactive"
    ? "recoverySettings.whatsappConsent.statusCheckoutInactive"
    : isCart ? cartStatusKey : STATUS_KEYS[status];
  const editorUrl = isCart ? activation.cartThemeEditorUrl : activation.checkoutEditorUrl;
  const needsPreparation = isPlus && status !== "active" || isCart && cartAction.needsPreparation;
  const primaryLabel = isPlus
    ? status === "active" ? "activationManage" : "activationAction"
    : cartAction.key;
  const canOpenEditor = Boolean(editorUrl);

  return (
    <section className="moda-recovery-panel moda-recovery-consent-panel"
      aria-labelledby="recovery-whatsapp-consent-heading">
      <div className="moda-recovery-panel-heading">
        <div>
          <h2 id="recovery-whatsapp-consent-heading">{t("recoverySettings.whatsappConsent.title")}</h2>
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
              : status === "active"
                ? "recoverySettings.whatsappConsent.cartActiveTitle"
                : "recoverySettings.whatsappConsent.cartTitle")}</h3>
            <p>{t(isPlus
              ? "recoverySettings.whatsappConsent.plusBody"
              : status === "active"
                ? "recoverySettings.whatsappConsent.cartActiveBody"
                : "recoverySettings.whatsappConsent.cartBody")}</p>
            <p role="status" data-activation-status={status}
              className={`moda-recovery-consent-status moda-recovery-consent-status-${status}`}>
              {t(statusKey)}
            </p>
            {needsPreparation && canOpenEditor ? (
              <button className="moda-recovery-consent-action" type="button"
                onClick={onActivate} disabled={busy || !onActivate} aria-busy={busy}>
                {t(preparing ? "recoverySettings.whatsappConsent.activationPreparing"
                  : `recoverySettings.whatsappConsent.${primaryLabel}`)}
              </button>
            ) : canOpenEditor ? (
              <a className="moda-recovery-consent-action" href={editorUrl!}
                target="_blank" rel="noopener noreferrer">
                {t(`recoverySettings.whatsappConsent.${primaryLabel}`)}
              </a>
            ) : (
              <p role="alert">{t("recoverySettings.whatsappConsent.statusUnavailable")}</p>
            )}
            {actionFailed ? <p role="alert">{t("recoverySettings.whatsappConsent.activationFailed")}</p> : null}
            {verificationFailed ? (
              <p role="status">{t("recoverySettings.whatsappConsent.activationCheckUnavailable")}</p>
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
