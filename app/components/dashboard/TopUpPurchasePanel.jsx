import React from "react";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

const statuses = ["REQUESTED", "ACTIVE", "COMPLETED", "WITHDRAWN", "REFUNDED"];

/** @param {{ merchantUi?: any, topUpState: { latestPurchase?: any, offers?: Array<any>, purchasedCreditsAvailable: number, offerVerificationState: string } }} props */

export default function TopUpPurchasePanel({ merchantUi, topUpState }) {
  const i18n = createMerchantI18n(merchantUi);
  const purchase = topUpState.latestPurchase;
  const reportState = purchase?.usageReportState;
  const offers = Array.isArray(topUpState.offers) ? topUpState.offers : [];

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
    {topUpState.offerVerificationState === "VERIFICATION_UNAVAILABLE" ? <div className="moda-empty-state">{i18n.t("billingCommerce.topup.verificationUnavailable")}</div> : offers.length === 0 ? <div className="moda-empty-state">{i18n.t("billingCommerce.topup.none")}</div> : offers.map((offer) => {
      const providerPrice = offer.providerNextUnitCost
        ? i18n.formatMoney(offer.providerNextUnitCost.amount, offer.providerNextUnitCost.currency)
        : null;
      return <article className="moda-topup-card moda-topup-card-featured" key={offer.eventHandle}>
        <div className="moda-topup-credit-count"><strong>{offer.creditsGranted}</strong><span>{i18n.t("billingCommerce.recoveryConversations")}</span></div>
        {providerPrice ? <p>{providerPrice}</p> : null}
        <form method="post" onSubmit={(event) => {
          event.currentTarget.purchaseId.value = crypto.randomUUID();
        }}>
          <input type="hidden" name="intent" value="BUY_RECOVERY_CREDIT_PACK" />
          <input type="hidden" name="purchaseId" value="" />
          <input type="hidden" name="eventHandle" value={offer.eventHandle} />
          <button type="submit" disabled={!topUpState.purchaseEligible || !offer.purchaseEligible}>Buy</button>
        </form>
        {offer.pendingPurchase?.usageReportState === "RETRYABLE" ? <p>{i18n.t("billingCommerce.topup.reportingRetry")}</p> : null}
        {offer.pendingPurchase?.usageReportState === "NEEDS_ATTENTION" ? <p>{i18n.t("billingCommerce.topup.reportingNeedsAttention")}</p> : null}
        {offer.blockReason === "REFUND_PENDING" ? <p>{i18n.t("billingCommerce.topup.meterBusy")}</p> : null}
      </article>;
    })}
    {purchase && statuses.includes(purchase.status) ? <p>
      {purchase.status === "REQUESTED"
        ? reportState === "RETRYABLE"
          ? i18n.t("billingCommerce.topup.reportingRetry")
          : reportState === "NEEDS_ATTENTION"
            ? i18n.t("billingCommerce.topup.reportingNeedsAttention")
            : i18n.t("billing.recoveryCreditPurchasePending")
        : `${i18n.t(`billingCommerce.purchaseStatus.${purchase.status}`)}: ${i18n.formatNumber(purchase.currentAmount)}`}
    </p> : null}
  </section>;
}

TopUpPurchasePanel.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  topUpState: PropTypes.shape({
    configured: PropTypes.bool.isRequired,
    purchaseEligible: PropTypes.bool.isRequired,
    offers: PropTypes.arrayOf(PropTypes.shape({ eventHandle: PropTypes.string.isRequired, cataloguePosition: PropTypes.number.isRequired, creditsGranted: PropTypes.number.isRequired, providerNextUnitCost: PropTypes.shape({ amount: PropTypes.string.isRequired, currency: PropTypes.string.isRequired }), purchaseEligible: PropTypes.bool.isRequired, blockReason: PropTypes.oneOf(["PURCHASE_PENDING", "REFUND_PENDING"]), pendingPurchase: PropTypes.shape({ id: PropTypes.string.isRequired, usageReportState: PropTypes.string.isRequired }) })),
    offerVerificationState: PropTypes.string.isRequired,
    purchasedCreditsAvailable: PropTypes.number.isRequired,
    latestPurchase: PropTypes.shape({ status: PropTypes.oneOf(statuses).isRequired, currentAmount: PropTypes.number.isRequired, usageReportState: PropTypes.string }),
  }).isRequired,
};
