import React from "react";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

/** @param {{ merchantUi: any, subscription: any, capacity: any }} props */
export default function LifecycleRestrictionBanner({ merchantUi, subscription, capacity }) {
  const i18n = createMerchantI18n(merchantUi);
  const pendingPlan = subscription?.pendingPlan;
  const scheduledCancellation = Boolean(
    subscription?.status === "ACTIVE" &&
    subscription.cancelAtEndOfCycle &&
    !pendingPlan &&
    subscription.currentPeriodEnd,
  );
  let message = null;

  if (capacity?.availability === "CONTRACT_FROZEN") {
    message = i18n.t("billing.frozenDescription");
  } else if (pendingPlan?.name && pendingPlan.effectiveAt) {
    message = i18n.t("billing.pendingChange", {
      plan: pendingPlan.name,
      date: i18n.formatDate(pendingPlan.effectiveAt),
    });
  } else if (scheduledCancellation) {
    message = i18n.t("billing.cancelAtPeriodEndOn", {
      date: i18n.formatDate(subscription.currentPeriodEnd),
    });
  } else if (capacity?.availability === "CONTRACT_REQUIRED") {
    message = i18n.t("billing.contractRequiredDescription");
  }

  return message ? <s-banner tone="warning">{message}</s-banner> : null;
}

LifecycleRestrictionBanner.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  subscription: PropTypes.object,
  capacity: PropTypes.object,
};