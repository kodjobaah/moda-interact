import React from "react";
import PropTypes from "prop-types";
import { useSubmit } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";

const statuses = ["REQUESTED", "ACTIVE", "COMPLETED", "WITHDRAWN", "REFUNDED"];

/** @param {{ merchantUi?: any, topUpState: { latestPurchase?: any, unresolvedPurchases?: Array<any>, offers?: Array<any>, freeLifetime?: { granted: number, remaining: number } | null, purchasedCreditsAvailable: number, offerVerificationState: string } }} props */

export default function TopUpPurchasePanel({ merchantUi, topUpState }) {
  const i18n = createMerchantI18n(merchantUi);
  const submit = useSubmit();
  const purchase = topUpState.latestPurchase;
  const offers = Array.isArray(topUpState.offers) ? topUpState.offers : [];
  const unresolvedPurchases = Array.isArray(topUpState.unresolvedPurchases)
    ? topUpState.unresolvedPurchases
    : [];
  const unresolvedByEventHandle = new Map(
    unresolvedPurchases.map((entry) => [entry.eventHandle, entry]),
  );
  const purchaseLabel = purchase
    ? (purchase.label ?? offers.find((offer) => offer.eventHandle === purchase.eventHandle)?.label ?? purchase.eventHandle)
    : null;
  const heldForRefundAmount =
    purchase?.status === "WITHDRAWN"
      ? Math.max(purchase.currentAmount - (purchase.reservedAmount ?? 0), 0)
      : 0;

  return <section className="moda-billing-panel">
    <div className="moda-panel-heading-row">
      <div>
        <div className="moda-eyebrow">{i18n.t("billingCommerce.topup.eyebrow")}</div>
        <h2>{i18n.t("billingCommerce.topup.title")}</h2>
        <p>{i18n.t("billingCommerce.topup.description")}</p>
      </div>
    </div>
    <div className="moda-credit-balance-grid">
      {topUpState.freeLifetime ? <div className="moda-credit-summary">
        <div className="moda-credit-icon">∞</div>
        <div>
          <strong>{i18n.formatNumber(topUpState.freeLifetime.remaining)}</strong>
          <span>{i18n.t("billingCommerce.lifetimeFree")}</span>
          <small>{i18n.t("billing.lifetimeFreeAllowance", { remaining: topUpState.freeLifetime.remaining, allowance: topUpState.freeLifetime.granted })}</small>
        </div>
      </div> : null}
      <div className="moda-credit-summary">
        <div className="moda-credit-icon">+</div>
        <div><strong>{i18n.formatNumber(topUpState.purchasedCreditsAvailable)}</strong><span>{i18n.t("billingCommerce.purchasedCredits")}</span></div>
        <p>{i18n.t("billingCommerce.topup.nonExpiring")}</p>
      </div>
    </div>
    <div className="moda-info-banner">
      <div className="moda-info-banner-icon">↗</div>
      <div><strong>{i18n.t("billingCommerce.topup.planBenefit")}</strong><p>{i18n.t("billingCommerce.topup.billingNote")}</p></div>
    </div>
    {topUpState.offerVerificationState === "VERIFICATION_UNAVAILABLE" ? <div className="moda-empty-state">{i18n.t("billingCommerce.topup.verificationUnavailable")}</div> : offers.length === 0 ? <div className="moda-empty-state">{i18n.t("billingCommerce.topup.none")}</div> : <div className="moda-topup-grid">{offers.map((offer) => {
      const tier = offer.providerPrice?.tiers?.[0];
      const providerAmount = tier?.amountPerUnit ?? tier?.amount;
      const providerPrice = providerAmount && offer.providerPrice?.currency
        ? i18n.formatMoney(Number(providerAmount), offer.providerPrice.currency)
        : null;
      const unresolvedPurchase = unresolvedByEventHandle.get(offer.eventHandle);
      const reportState = unresolvedPurchase?.usageReportState;
      const offerPurchaseEligible = topUpState.purchaseEligible && !unresolvedPurchase;
      return <article className="moda-topup-card moda-topup-card-featured" key={offer.eventHandle}>
        <div className="moda-topup-pack-label">{offer.label}</div>
        <div className="moda-topup-credit-count"><strong>{offer.creditsGranted}</strong><span>{i18n.t("billingCommerce.recoveryConversations")}</span></div>
        {providerPrice ? <p>{providerPrice} {i18n.t("billingCommerce.perConversation")}</p> : null}
        <form method="post" onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          formData.set("purchaseId", crypto.randomUUID());
          submit(formData, { method: "post" });
        }}>
          <input type="hidden" name="intent" value="BUY_RECOVERY_CREDIT_PACK" />
          <input type="hidden" name="purchaseId" value="" />
          <input type="hidden" name="eventHandle" value={offer.eventHandle} />
          <button
            className="moda-action-button moda-action-button-primary moda-topup-buy-button"
            type="submit"
            disabled={!offerPurchaseEligible}
            aria-label={`${i18n.t("billingCommerce.buy")} ${i18n.formatNumber(offer.creditsGranted)} ${i18n.t("billingCommerce.recoveryConversations")}`}
          >
            {i18n.t("billingCommerce.buy")}
          </button>
        </form>
        {unresolvedPurchase && reportState === "RETRYABLE" ? <p>{i18n.t("billingCommerce.topup.reportingRetry")}</p> : null}
        {unresolvedPurchase && reportState === "NEEDS_ATTENTION" ? <p>{i18n.t("billingCommerce.topup.reportingNeedsAttention")}</p> : null}
        {unresolvedPurchase && reportState !== "RETRYABLE" && reportState !== "NEEDS_ATTENTION" ? <p>{i18n.t("billing.recoveryCreditPurchasePending")}</p> : null}
      </article>;
    })}</div>}
    {purchase && purchase.status !== "REQUESTED" && statuses.includes(purchase.status) ? <div className="moda-latest-purchase-summary">
      <div>
        <span>{i18n.t("billingPurchases.purchaseLabel")}</span>
        <strong>{purchaseLabel}</strong>
      </div>
      <div>
        <span>{i18n.t(`billingCommerce.purchaseStatus.${purchase.status}`)}</span>
        {purchase.status === "WITHDRAWN" ? (
          <strong>
            {i18n.t("billingPurchases.refundSummary", {
              current: i18n.formatNumber(purchase.currentAmount),
              reserved: i18n.formatNumber(purchase.reservedAmount ?? 0),
              available: i18n.formatNumber(heldForRefundAmount),
            })}
          </strong>
        ) : (
          <strong>{i18n.formatNumber(purchase.currentAmount)} {i18n.t("billingPurchases.availableCredits")}</strong>
        )}
      </div>
    </div> : null}
  </section>;
}

TopUpPurchasePanel.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  topUpState: PropTypes.shape({
    configured: PropTypes.bool.isRequired,
    purchaseEligible: PropTypes.bool.isRequired,
    offers: PropTypes.arrayOf(PropTypes.shape({ eventHandle: PropTypes.string.isRequired, label: PropTypes.string.isRequired, cataloguePosition: PropTypes.number.isRequired, creditsGranted: PropTypes.number.isRequired, providerPrice: PropTypes.shape({ currency: PropTypes.string, tiers: PropTypes.arrayOf(PropTypes.shape({ amountPerUnit: PropTypes.string, amount: PropTypes.string })) }).isRequired, providerUsage: PropTypes.object })),
    offerVerificationState: PropTypes.string.isRequired,
    freeLifetime: PropTypes.shape({ granted: PropTypes.number.isRequired, remaining: PropTypes.number.isRequired }),
    purchasedCreditsAvailable: PropTypes.number.isRequired,
    latestPurchase: PropTypes.shape({ status: PropTypes.oneOf(statuses).isRequired, currentAmount: PropTypes.number.isRequired, reservedAmount: PropTypes.number, usageReportState: PropTypes.string, eventHandle: PropTypes.string, label: PropTypes.string }),
    unresolvedPurchases: PropTypes.arrayOf(PropTypes.shape({ eventHandle: PropTypes.string.isRequired, creditsGranted: PropTypes.number.isRequired, usageReportState: PropTypes.string.isRequired })),
  }).isRequired,
};
