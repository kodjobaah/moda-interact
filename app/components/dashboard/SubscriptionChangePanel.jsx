import React from "react";
import PropTypes from "prop-types";
import { Link } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";

/** @typedef {{ shopifyPlanHandle: string, mappedModaPlanName?: string|null, price?: { amount: string, currency?: string|null }|null, interval?: string|null, effectiveAt?: string|null, currentPeriodEnd?: string|null }} ProviderPlanData */

/** @param {any} i18n @param {any} interval */
function providerPeriodLabel(i18n, interval) {
  if (!interval) return null;
  return interval === "EVERY_30_DAYS" ? i18n.t("billingCommerce.perMonth") : interval;
}

/** @param {{ plan: ProviderPlanData, i18n: any, current?: boolean, pending?: boolean }} props */
function ProviderPlan({ plan, i18n, current = false, pending = false }) {
  if (!plan) return null;
  const amount = plan.price ? Number(plan.price.amount) : null;
  const price = plan.price
    ? amount !== null && Number.isFinite(amount) && plan.price.currency
      ? i18n.formatMoney(amount, plan.price.currency, { maximumFractionDigits: 2 })
      : plan.price.amount
    : null;
  const currencyUnavailable = Boolean(plan.price && !plan.price.currency);
  const intervalLabel = providerPeriodLabel(i18n, plan.interval);
  const planName = plan.mappedModaPlanName ?? plan.shopifyPlanHandle;
  const pendingLabel = pending && plan.effectiveAt
    ? i18n.t("billing.pendingChange", { plan: planName, date: i18n.formatDate(plan.effectiveAt) })
    : null;

  return <article className={`moda-plan-card${current ? " moda-plan-card-current" : ""}`}>
    <div className="moda-plan-card-top">
      <div>
        {current ? <span className="moda-plan-relation is-current">{i18n.t("billingCommerce.plans.current")}</span> : null}
        {pendingLabel ? <span className="moda-plan-relation">{pendingLabel}</span> : null}
        <h3>{planName}</h3>
      </div>
      {current ? <span className="moda-current-check" aria-hidden="true">✓</span> : null}
    </div>
    {price !== null ? <div className="moda-plan-price">
      <strong>{price}</strong>
      <span>{currencyUnavailable ? i18n.t("billing.configurationUnavailable") : intervalLabel}</span>
    </div> : null}
    {plan.effectiveAt && !pendingLabel ? <span>{i18n.formatDate(plan.effectiveAt)}</span> : null}
  </article>;
}

ProviderPlan.propTypes = {
  plan: PropTypes.shape({
    shopifyPlanHandle: PropTypes.string.isRequired,
    price: PropTypes.shape({ amount: PropTypes.string.isRequired, currency: PropTypes.string }),
    interval: PropTypes.string,
    mappedModaPlanName: PropTypes.string,
    effectiveAt: PropTypes.string,
  }),
  i18n: PropTypes.object.isRequired,
  current: PropTypes.bool,
  pending: PropTypes.bool,
};

/** @param {{ merchantUi: any, current: any, pending: any, requestedSelection?: any, providerVerificationState: string, managePlansHref?: string|null, managePlansAvailable: boolean }} props */
export default function SubscriptionChangePanel({ merchantUi, current, pending, requestedSelection, providerVerificationState, managePlansHref, managePlansAvailable }) {
  const i18n = createMerchantI18n(merchantUi);
  const hasCurrent = Boolean(current);
  return <section className="moda-billing-panel">
    <div className="moda-eyebrow">{i18n.t("billingCommerce.plans.eyebrow")}</div>
    <h2>{i18n.t("billingCommerce.plans.title")}</h2>
    <p>{i18n.t("billingCommerce.plans.shopifyApproval")}</p>
    {providerVerificationState === "VERIFICATION_UNAVAILABLE" ? <p>{i18n.t("billing.verificationUnavailableDescription")}</p> : null}
    {providerVerificationState === "NO_ACTIVE_SUBSCRIPTION" ? <p>{i18n.t("billing.viewPlans")}</p> : null}
    {hasCurrent ? <div className="moda-plan-grid">
      <ProviderPlan i18n={i18n} plan={{ ...current }} current />
      {pending ? <ProviderPlan i18n={i18n} pending plan={pending} /> : null}
    </div> : null}
    {hasCurrent && !current.mappedModaPlanName ? <p>{i18n.t("billing.configurationUnavailable")}</p> : null}
    {current?.cancelAtEndOfCycle && !pending && current.currentPeriodEnd ? <p>{i18n.t("billing.cancelAtPeriodEndOn", { date: i18n.formatDate(current.currentPeriodEnd) })}</p> : null}
    {requestedSelection ? <div className="moda-provider-plan-awaiting-confirmation"><strong>{requestedSelection.shopifyPlanHandle}</strong><span>{i18n.t("billingCommerce.plans.awaitingShopifyConfirmation")}</span></div> : null}
    {!hasCurrent && !["VERIFICATION_UNAVAILABLE", "NO_ACTIVE_SUBSCRIPTION"].includes(providerVerificationState) ? <p>{i18n.t("billing.configurationUnavailable")}</p> : null}
    {managePlansAvailable && managePlansHref ? <div className="moda-plan-actions"><Link className="moda-action-button moda-action-button-primary" to={managePlansHref}>{hasCurrent ? i18n.t("billing.changePlan") : i18n.t("billing.viewPlans")}</Link></div> : null}
  </section>;
}

SubscriptionChangePanel.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  current: PropTypes.shape({ shopifyPlanHandle: PropTypes.string.isRequired, mappedModaPlanName: PropTypes.string, price: PropTypes.shape({ amount: PropTypes.string.isRequired, currency: PropTypes.string }), interval: PropTypes.string, cancelAtEndOfCycle: PropTypes.bool.isRequired }),
  pending: PropTypes.shape({ shopifyPlanHandle: PropTypes.string.isRequired, mappedModaPlanName: PropTypes.string, price: PropTypes.shape({ amount: PropTypes.string.isRequired, currency: PropTypes.string }).isRequired, effectiveAt: PropTypes.string }),
  requestedSelection: PropTypes.shape({ shopifyPlanHandle: PropTypes.string.isRequired }),
  providerVerificationState: PropTypes.string.isRequired,
  managePlansHref: PropTypes.string,
  managePlansAvailable: PropTypes.bool.isRequired,
};
