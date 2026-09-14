import React from "react";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

/** @typedef {{ shopifyPlanHandle: string, mappedModaPlanName?: string|null, price: { amount: string, currency?: string|null }, interval?: string, effectiveAt?: string|null }} ProviderPlanData */

/** @param {{ plan: ProviderPlanData, i18n: any, pending?: boolean }} props */
function ProviderPlan({ plan, i18n, pending = false }) {
  if (!plan) return null;
  const amount = Number(plan.price.amount);
  const price = Number.isFinite(amount) && plan.price.currency
    ? i18n.formatMoney(amount, plan.price.currency, { maximumFractionDigits: 2 })
    : plan.price.amount;
  const currencyUnavailable = !plan.price.currency;
  return <div className={pending ? "moda-provider-plan moda-provider-plan-pending" : "moda-provider-plan"}>
    <strong>{plan.shopifyPlanHandle}</strong>
    <span>{price}{currencyUnavailable ? ` - ${i18n.t("billing.configurationUnavailable")}` : ""}{plan.interval ? ` - ${plan.interval}` : ""}</span>
    {plan.effectiveAt ? <span>{i18n.formatDate(plan.effectiveAt)}</span> : null}
    {plan.mappedModaPlanName ? <span>{plan.mappedModaPlanName}</span> : null}
  </div>;
}

ProviderPlan.propTypes = {
  plan: PropTypes.shape({
    shopifyPlanHandle: PropTypes.string.isRequired,
    price: PropTypes.shape({ amount: PropTypes.string.isRequired, currency: PropTypes.string }).isRequired,
    interval: PropTypes.string,
    mappedModaPlanName: PropTypes.string,
    effectiveAt: PropTypes.string,
  }),
  i18n: PropTypes.object.isRequired,
  pending: PropTypes.bool,
};

/** @param {{ merchantUi: any, current: ProviderPlanData & { cancelAtEndOfCycle: boolean }|null, pending: ProviderPlanData|null, requestedSelection?: { shopifyPlanHandle: string }|null, providerVerificationState: string, managePlansHref?: string|null, managePlansAvailable: boolean }} props */
export default function SubscriptionChangePanel({ merchantUi, current, pending, requestedSelection, providerVerificationState, managePlansHref, managePlansAvailable }) {
  const i18n = createMerchantI18n(merchantUi);
  const hasCurrent = providerVerificationState === "ACTIVE_SUBSCRIPTION" && current;
  return <section className="moda-billing-panel">
    <div className="moda-eyebrow">{i18n.t("billingCommerce.plans.eyebrow")}</div>
    <h2>{i18n.t("billingCommerce.plans.title")}</h2>
    <p>{i18n.t("billingCommerce.plans.shopifyApproval")}</p>
    {providerVerificationState === "VERIFICATION_UNAVAILABLE" ? <p>{i18n.t("billing.verificationUnavailableDescription")}</p> : null}
    {providerVerificationState === "NO_ACTIVE_SUBSCRIPTION" ? <p>{i18n.t("billing.viewPlans")}</p> : null}
    {hasCurrent ? <>
      <ProviderPlan i18n={i18n} plan={{ ...current }} />
      <p>{current.mappedModaPlanName || i18n.t("billing.configurationUnavailable")}{current.cancelAtEndOfCycle ? ` - ${i18n.t("billing.cancelAtPeriodEnd")}` : ""}</p>
      {pending ? <ProviderPlan i18n={i18n} pending plan={pending} /> : null}
    </> : null}
    {requestedSelection ? <div className="moda-provider-plan-awaiting-confirmation"><strong>{requestedSelection.shopifyPlanHandle}</strong><span>{i18n.t("billingCommerce.plans.awaitingShopifyConfirmation")}</span></div> : null}
    {!hasCurrent && !["VERIFICATION_UNAVAILABLE", "NO_ACTIVE_SUBSCRIPTION"].includes(providerVerificationState) ? <p>{i18n.t("billing.configurationUnavailable")}</p> : null}
    {managePlansAvailable && managePlansHref ? <a className="moda-action-button moda-action-button-primary" href={managePlansHref} target="_top" rel="noreferrer">{i18n.t("billingCommerce.actions.plan")}</a> : null}
  </section>;
}

SubscriptionChangePanel.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  current: PropTypes.shape({ shopifyPlanHandle: PropTypes.string.isRequired, mappedModaPlanName: PropTypes.string, price: PropTypes.shape({ amount: PropTypes.string.isRequired, currency: PropTypes.string }).isRequired, interval: PropTypes.string.isRequired, cancelAtEndOfCycle: PropTypes.bool.isRequired }),
  pending: PropTypes.shape({ shopifyPlanHandle: PropTypes.string.isRequired, mappedModaPlanName: PropTypes.string, price: PropTypes.shape({ amount: PropTypes.string.isRequired, currency: PropTypes.string }).isRequired, effectiveAt: PropTypes.string }),
  requestedSelection: PropTypes.shape({ shopifyPlanHandle: PropTypes.string.isRequired }),
  providerVerificationState: PropTypes.string.isRequired,
  managePlansHref: PropTypes.string,
  managePlansAvailable: PropTypes.bool.isRequired,
};
