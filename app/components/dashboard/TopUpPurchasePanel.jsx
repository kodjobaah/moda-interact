import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

const statuses = ["REQUESTED", "ACTIVE", "COMPLETED", "WITHDRAWN", "REFUNDED"];

/** @param {{ merchantUi?: { locale?: string, timeZone?: string }, topUpState: { configured: boolean, purchaseEligible: boolean, creditsPerPack: number|null, purchasedCreditsAvailable: number, shopifyPackMeter: { price?: { amount?: string, currency?: string|null } }|null, latestPurchase: { status: string, currentAmount: number }|null }, onPurchaseTopUp?: () => void }} props */

export default function TopUpPurchasePanel({ merchantUi, topUpState, onPurchaseTopUp }) {
  const i18n = createMerchantI18n(merchantUi);
  const purchase = topUpState.latestPurchase;
  const hasUnresolvedPurchase = purchase?.status === "REQUESTED";
  const canPurchase = topUpState.purchaseEligible && !hasUnresolvedPurchase;
  const price = topUpState.shopifyPackMeter?.price;

  return <section className="moda-billing-panel">
    <div className="moda-panel-heading-row">
      <div>
        <div className="moda-eyebrow">{i18n.t("billingCommerce.topup.eyebrow")}</div>
        <h2>{i18n.t("billingCommerce.topup.title")}</h2>
        <p>{i18n.t("billingCommerce.topup.description")}</p>
      </div>
    </div>
    <div className="moda-credit-summary">
      <div className="moda-credit-icon">+</div>
      <div><strong>{topUpState.purchasedCreditsAvailable}</strong><span>{i18n.t("billingCommerce.purchasedCredits")}</span></div>
      <p>{i18n.t("billingCommerce.topup.nonExpiring")}</p>
    </div>
    <div className="moda-info-banner">
      <div className="moda-info-banner-icon">↗</div>
      <div><strong>{i18n.t("billingCommerce.topup.planBenefit")}</strong><p>{i18n.t("billingCommerce.topup.billingNote")}</p></div>
    </div>
    {topUpState.configured && topUpState.creditsPerPack ? <article className="moda-topup-card moda-topup-card-featured">
      <div className="moda-topup-credit-count"><strong>{topUpState.creditsPerPack}</strong><span>{i18n.t("billingCommerce.recoveryConversations")}</span></div>
      {price?.amount && price.currency ? <div className="moda-topup-price">{price.amount} {price.currency}</div> : <p>{i18n.t("billingCommerce.topup.billingNote")}</p>}
      {canPurchase ? <button className="moda-action-button moda-action-button-primary" type="button" onClick={onPurchaseTopUp}>{i18n.t("billingCommerce.buy")}</button> : null}
      {hasUnresolvedPurchase ? <p>{i18n.t("billingCommerce.topup.billingNote")}</p> : null}
    </article> : <div className="moda-empty-state">{i18n.t("billingCommerce.topup.none")}</div>}
    {purchase && statuses.includes(purchase.status) ? <p>
      {purchase.status === "REQUESTED"
        ? i18n.t("billing.recoveryCreditPurchasePending")
        : `${i18n.t(`billingCommerce.purchaseStatus.${purchase.status}`)}: ${i18n.formatNumber(purchase.currentAmount)}`}
    </p> : null}
  </section>;
}

TopUpPurchasePanel.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  topUpState: PropTypes.shape({
    configured: PropTypes.bool.isRequired,
    purchaseEligible: PropTypes.bool.isRequired,
    creditsPerPack: PropTypes.number,
    purchasedCreditsAvailable: PropTypes.number.isRequired,
    shopifyPackMeter: PropTypes.shape({ price: PropTypes.object }),
    latestPurchase: PropTypes.shape({ status: PropTypes.oneOf(statuses).isRequired, currentAmount: PropTypes.number.isRequired }),
  }).isRequired,
  onPurchaseTopUp: PropTypes.func,
};
