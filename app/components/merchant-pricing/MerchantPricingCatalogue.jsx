import React from "react";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import "./MerchantPricingCatalogue.css";

void React;

export default function MerchantPricingCatalogue({ merchantUi, pricingCatalogue, showChoosePlanAction }) {
  const i18n = createMerchantI18n(merchantUi);
  const plans = pricingCatalogue ?? [];

  if (plans.length === 0) {
    return <p className="mi-pricing-catalogue-unavailable">{i18n.t("onboarding.pricing.unavailable")}</p>;
  }

  return (
    <div className="mi-pricing-catalogue">
      <div className="mi-pricing-catalogue-grid">
        {plans.map((plan) => {
          const lifetime = plan.planKind === "FREE" || plan.allowancePeriod === "LIFETIME";
          return (
            <article className={`mi-pricing-catalogue-card${plan.featured ? " mi-pricing-catalogue-card-featured" : ""}`} key={plan.shopifyPlanHandle}>
              <div className="mi-pricing-catalogue-pill">{plan.displayName}</div>
              {plan.featured && <div className="mi-pricing-catalogue-badge">{i18n.t("onboarding.pricing.mostPopular")}</div>}
              <h3>{plan.displayName}</h3>
              <div className="mi-pricing-catalogue-price">
                {i18n.formatMoney(plan.recurringAmountMinor / 100, plan.currency)}
                {plan.billingPeriod === "EVERY_30_DAYS" && <span>{i18n.t("onboarding.pricing.perMonth")}</span>}
              </div>
              <p className="mi-pricing-catalogue-description">{plan.localizedDescription}</p>
              <div className={`mi-pricing-catalogue-allowance${lifetime ? " mi-pricing-catalogue-allowance-neutral" : ""}`}>
                <strong>{plan.includedRecoveryCredits}</strong>
                <span>{i18n.t(plan.allowancePeriod === "LIFETIME" ? "onboarding.pricing.lifetimeAllowance" : "onboarding.pricing.monthlyAllowance")}</span>
              </div>
              <div className="mi-pricing-catalogue-highlights">
                {plan.highlights.map((highlight) => (
                  <div className="mi-pricing-catalogue-highlight" key={highlight.contentKey}>
                    <strong>{highlight.title}</strong>
                    <span>{highlight.description}</span>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
      </div>
      {showChoosePlanAction && <s-button href="/app/billing/select" variant="primary">{i18n.t("onboarding.choosePlan")}</s-button>}
    </div>
  );
}

MerchantPricingCatalogue.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  pricingCatalogue: PropTypes.arrayOf(PropTypes.shape({
    shopifyPlanHandle: PropTypes.string.isRequired,
    displayName: PropTypes.string.isRequired,
    planKind: PropTypes.string.isRequired,
    featured: PropTypes.bool.isRequired,
    localizedDescription: PropTypes.string.isRequired,
    includedRecoveryCredits: PropTypes.number.isRequired,
    allowancePeriod: PropTypes.string.isRequired,
    billingPeriod: PropTypes.string.isRequired,
    recurringAmountMinor: PropTypes.number.isRequired,
    currency: PropTypes.string.isRequired,
    highlights: PropTypes.arrayOf(PropTypes.shape({
      contentKey: PropTypes.string.isRequired,
      position: PropTypes.number.isRequired,
      title: PropTypes.string.isRequired,
      description: PropTypes.string.isRequired,
    })).isRequired,
  })),
  showChoosePlanAction: PropTypes.bool,
};