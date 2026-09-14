import { useState } from "react";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import TopUpPurchasePanel from "./TopUpPurchasePanel";
import SubscriptionChangePanel from "./SubscriptionChangePanel";
import "./BillingPurchaseHub.css";

/** @param {{ merchantUi: any, capacity?: any, billingPeriodPhase?: string|null, lifecycleState: string, verificationState: string, topUpState: any, current?: any, pending?: any, managePlansHref: string, managePlansAvailable: boolean, initialView?: "topup"|"plans", onPurchaseTopUp: () => void }} props */
export default function BillingPurchaseHub({ merchantUi, capacity, billingPeriodPhase, lifecycleState, verificationState, topUpState, current, pending, managePlansHref, managePlansAvailable, initialView="topup", onPurchaseTopUp }) {
  const i18n=createMerchantI18n(merchantUi); const [view,setView]=useState(initialView);
  const currentName = current?.mappedModaPlanName ?? current?.shopifyPlanHandle ?? (verificationState === "NO_ACTIVE_SUBSCRIPTION" ? i18n.t("billing.viewPlans") : i18n.t("billing.configurationUnavailable"));
  const stateCopy = lifecycleState === "FROZEN" || billingPeriodPhase === "DRAINING" || billingPeriodPhase === "RECONCILING"
    ? i18n.t("billing.configurationUnavailableDescription")
    : null;
  const paidIncluded = capacity?.paidIncluded?.remaining ?? null;
  const freeLifetime = capacity?.freeLifetime?.remaining ?? null;
  const promotional = capacity?.promotional?.remaining ?? 0;
  const purchased = capacity?.purchased?.available ?? 0;
  return <div className="moda-billing-commerce">
    <section className="moda-billing-hero"><div className="moda-billing-hero-copy"><div className="moda-eyebrow">{i18n.t("billingCommerce.page.eyebrow")}</div><h1>{i18n.t("billingCommerce.page.heading")}</h1><p>{stateCopy ?? i18n.t("billingCommerce.page.description")}</p><div className="moda-billing-actions"><button className={`moda-action-button ${view==="topup"?"moda-action-button-primary":"moda-action-button-secondary"}`} onClick={()=>setView("topup")}>{i18n.t("billingCommerce.actions.topup")}</button><button className={`moda-action-button ${view==="plans"?"moda-action-button-primary":"moda-action-button-secondary"}`} onClick={()=>setView("plans")}>{i18n.t("billingCommerce.actions.plan")}</button></div></div>
    <div className="moda-billing-summary-card"><div className="moda-summary-plan"><span>{i18n.t("billingCommerce.currentPlan")}</span><strong>{currentName}</strong></div><div className="moda-summary-metrics"><div><strong>{paidIncluded ?? freeLifetime ?? 0}</strong><span>{paidIncluded !== null ? i18n.t("billing.paidIncludedAllowance") : i18n.t("billing.lifetimeFreeAllowance")}</span></div><div><strong>{promotional}</strong><span>{i18n.t("billingCommerce.promotionalCredits")}</span></div><div><strong>{purchased}</strong><span>{i18n.t("billingCommerce.purchasedCredits")}</span></div></div><div className="moda-summary-graphic"><span></span><span></span><span></span><span></span><span></span></div></div></section>
    <div className="moda-view-switch"><button className={view==="topup"?"is-active":""} onClick={()=>setView("topup")}>{i18n.t("billingCommerce.actions.topup")}</button><button className={view==="plans"?"is-active":""} onClick={()=>setView("plans")}>{i18n.t("billingCommerce.actions.plan")}</button></div>
    {view === "topup" ? (
      <TopUpPurchasePanel merchantUi={merchantUi} topUpState={topUpState} onPurchaseTopUp={onPurchaseTopUp} />
    ) : (
      <SubscriptionChangePanel merchantUi={merchantUi} current={current} pending={pending} providerVerificationState={verificationState} managePlansHref={managePlansHref} managePlansAvailable={managePlansAvailable} />
    )}
  </div>;
}

BillingPurchaseHub.propTypes={ merchantUi:PropTypes.shape({locale:PropTypes.string,timeZone:PropTypes.string}).isRequired, capacity:PropTypes.object, billingPeriodPhase:PropTypes.string, lifecycleState:PropTypes.string.isRequired, verificationState:PropTypes.string.isRequired, topUpState:PropTypes.object.isRequired, current:PropTypes.object, pending:PropTypes.object, managePlansHref:PropTypes.string.isRequired, managePlansAvailable:PropTypes.bool.isRequired, initialView:PropTypes.oneOf(["topup","plans"]), onPurchaseTopUp:PropTypes.func.isRequired };
