import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import TopUpPurchasePanel from "./TopUpPurchasePanel";
import SubscriptionChangePanel from "./SubscriptionChangePanel";
import { mockBillingState, mockPlans, mockTopUpOffers } from "./billing-purchase.mock";
import "./BillingPurchaseHub.css";

export default function BillingPurchaseHub({ merchantUi, currentPlanId=mockBillingState.currentPlanId, monthlyUsed=mockBillingState.monthlyUsed, purchasedCreditsAvailable=mockBillingState.purchasedCreditsAvailable, plans=mockPlans, topUpOffers=mockTopUpOffers, initialView="topup", onPurchaseTopUp, onChangePlan }) {
  const i18n=createMerchantI18n(merchantUi); const [view,setView]=useState(initialView);
  const currentPlan=useMemo(()=>plans.find((p)=>p.id===currentPlanId)||plans[0],[plans,currentPlanId]);
  return <s-page heading={i18n.t("billingCommerce.page.title")}><div className="moda-billing-commerce">
    <section className="moda-billing-hero"><div className="moda-billing-hero-copy"><div className="moda-eyebrow">{i18n.t("billingCommerce.page.eyebrow")}</div><h1>{i18n.t("billingCommerce.page.heading")}</h1><p>{i18n.t("billingCommerce.page.description")}</p><div className="moda-billing-actions"><button className={`moda-action-button ${view==="topup"?"moda-action-button-primary":"moda-action-button-secondary"}`} onClick={()=>setView("topup")}>{i18n.t("billingCommerce.actions.topup")}</button><button className={`moda-action-button ${view==="plans"?"moda-action-button-primary":"moda-action-button-secondary"}`} onClick={()=>setView("plans")}>{i18n.t("billingCommerce.actions.plan")}</button></div></div>
    <div className="moda-billing-summary-card"><div className="moda-summary-plan"><span>{i18n.t("billingCommerce.currentPlan")}</span><strong>{currentPlan.name}</strong></div><div className="moda-summary-metrics"><div><strong>{currentPlan.allowanceType==="monthly"?`${monthlyUsed} / ${currentPlan.includedConversations}`:currentPlan.includedConversations}</strong><span>{currentPlan.allowanceType==="monthly"?i18n.t("billingCommerce.monthlyUsed"):i18n.t("billingCommerce.lifetimeFree")}</span></div><div><strong>{purchasedCreditsAvailable}</strong><span>{i18n.t("billingCommerce.purchasedCredits")}</span></div></div><div className="moda-summary-graphic"><span></span><span></span><span></span><span></span><span></span></div></div></section>
    <div className="moda-view-switch"><button className={view==="topup"?"is-active":""} onClick={()=>setView("topup")}>{i18n.t("billingCommerce.actions.topup")}</button><button className={view==="plans"?"is-active":""} onClick={()=>setView("plans")}>{i18n.t("billingCommerce.actions.plan")}</button></div>
    {view==="topup"?<TopUpPurchasePanel merchantUi={merchantUi} currentPlan={currentPlan} topUpOffers={topUpOffers} purchasedCreditsAvailable={purchasedCreditsAvailable} onPurchaseTopUp={onPurchaseTopUp}/>:<SubscriptionChangePanel merchantUi={merchantUi} currentPlanId={currentPlanId} plans={plans} onChangePlan={onChangePlan}/>} 
  </div></s-page>;
}

BillingPurchaseHub.propTypes={ merchantUi:PropTypes.shape({locale:PropTypes.string,timeZone:PropTypes.string}), currentPlanId:PropTypes.string, monthlyUsed:PropTypes.number, purchasedCreditsAvailable:PropTypes.number, plans:PropTypes.array, topUpOffers:PropTypes.array, initialView:PropTypes.oneOf(["topup","plans"]), onPurchaseTopUp:PropTypes.func, onChangePlan:PropTypes.func };
