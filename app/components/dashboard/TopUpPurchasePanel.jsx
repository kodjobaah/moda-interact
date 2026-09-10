import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

function money(minor, currency, locale) {
  return new Intl.NumberFormat(locale || "en", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100);
}

export default function TopUpPurchasePanel({ merchantUi, currentPlan, topUpOffers, purchasedCreditsAvailable = 0, onPurchaseTopUp }) {
  const i18n = createMerchantI18n(merchantUi);
  const locale = merchantUi?.locale || "en";
  const offers = topUpOffers.filter((o) => o.planId === currentPlan.id).sort((a,b) => a.chargeAmountMinor-b.chargeAmountMinor);

  return <section className="moda-billing-panel">
    <div className="moda-panel-heading-row">
      <div>
        <div className="moda-eyebrow">{i18n.t("billingCommerce.topup.eyebrow")}</div>
        <h2>{i18n.t("billingCommerce.topup.title")}</h2>
        <p>{i18n.t("billingCommerce.topup.description")}</p>
      </div>
      <div className="moda-current-plan-pill"><span>{i18n.t("billingCommerce.currentPlan")}</span><strong>{currentPlan.name}</strong></div>
    </div>

    <div className="moda-credit-summary">
      <div className="moda-credit-icon">+</div>
      <div><strong>{purchasedCreditsAvailable}</strong><span>{i18n.t("billingCommerce.purchasedCredits")}</span></div>
      <p>{i18n.t("billingCommerce.topup.nonExpiring")}</p>
    </div>

    <div className="moda-info-banner"><div className="moda-info-banner-icon">↗</div><div><strong>{i18n.t("billingCommerce.topup.planBenefit")}</strong><p>{i18n.t("billingCommerce.topup.billingNote")}</p></div></div>

    {offers.length ? <div className="moda-topup-grid">{offers.map((offer,index) => {
      const price=money(offer.chargeAmountMinor, offer.currency, locale);
      const unit=money(offer.chargeAmountMinor/offer.creditsGranted, offer.currency, locale);
      return <article key={offer.id} className={`moda-topup-card${index===offers.length-1 ? " moda-topup-card-featured" : ""}`}>
        {index===offers.length-1 && <span className="moda-card-marker">{i18n.t("billingCommerce.topup.largestPack")}</span>}
        <div className="moda-topup-price">{price}</div>
        <div className="moda-topup-credit-count"><strong>{offer.creditsGranted}</strong><span>{i18n.t("billingCommerce.recoveryConversations")}</span></div>
        <div className="moda-unit-price"><span>{unit}</span><small>{i18n.t("billingCommerce.perConversation")}</small></div>
        <button className="moda-action-button moda-action-button-primary" type="button" onClick={() => onPurchaseTopUp?.(offer)}>{i18n.t("billingCommerce.buy")} {price}</button>
      </article>;
    })}</div> : <div className="moda-empty-state">{i18n.t("billingCommerce.topup.none")}</div>}
  </section>;
}

TopUpPurchasePanel.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  currentPlan: PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string.isRequired }).isRequired,
  topUpOffers: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string.isRequired, planId: PropTypes.string.isRequired, chargeAmountMinor: PropTypes.number.isRequired, currency: PropTypes.string.isRequired, creditsGranted: PropTypes.number.isRequired })).isRequired,
  purchasedCreditsAvailable: PropTypes.number,
  onPurchaseTopUp: PropTypes.func,
};
