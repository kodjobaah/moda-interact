import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

function money(minor = 0, currency = "GBP", locale = "en") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: minor === 0 ? 0 : 2,
  }).format(minor / 100);
}

export default function SubscriptionChangePanel({
  merchantUi,
  currentPlanId,
  plans = [],
  onChangePlan,
}) {
  const i18n = createMerchantI18n(merchantUi);
  const locale = merchantUi?.locale || "en";

  const currentPlan = plans.find((plan) => plan.id === currentPlanId);

  if (!currentPlan) {
    console.warn("SubscriptionChangePanel: current plan not found", {
      currentPlanId,
      plans,
    });

    return null;
  }

  return (
    <section className="moda-billing-panel">
      <div className="moda-eyebrow">
        {i18n.t("billingCommerce.plans.eyebrow")}
      </div>

      <h2>{i18n.t("billingCommerce.plans.title")}</h2>

      <p>{i18n.t("billingCommerce.plans.description")}</p>

      <div className="moda-plan-grid">
        {plans
          .slice()
          .sort((a, b) => a.rank - b.rank)
          .map((plan) => {
            const isCurrent = plan.id === currentPlanId;

            const isUpgrade = plan.rank > currentPlan.rank;

            const isDowngrade = plan.rank < currentPlan.rank;

            return (
              <article
                key={plan.id}
                className={`moda-plan-card${
                  isCurrent ? " moda-plan-card-current" : ""
                }`}
              >
                <div className="moda-plan-card-top">
                  <div>
                    <span
                      className={`moda-plan-relation${
                        isCurrent ? " is-current" : ""
                      }`}
                    >
                      {isCurrent && i18n.t("billingCommerce.plans.current")}

                      {isUpgrade && i18n.t("billingCommerce.plans.upgrade")}

                      {isDowngrade && i18n.t("billingCommerce.plans.downgrade")}
                    </span>

                    <h3>{plan.name}</h3>
                  </div>

                  {isCurrent && <div className="moda-current-check">✓</div>}
                </div>
                <div className="moda-plan-price">
                  <strong>
                    {money(
                      plan.monthlyPriceMinor,
                      plan.currency || "GBP",
                      locale,
                    )}
                  </strong>

                  {plan.monthlyPriceMinor > 0 && (
                    <span>{i18n.t("billingCommerce.perMonth")}</span>
                  )}
                </div>

                <div className="moda-plan-allowance">
                  <strong>{plan.includedConversations}</strong>

                  <span>
                    {plan.allowanceType === "lifetime"
                      ? i18n.t("billingCommerce.plans.lifetime")
                      : i18n.t("billingCommerce.plans.monthly")}
                  </span>
                </div>

                <div className="moda-plan-benefits">
                  <div>✓ {i18n.t("billingCommerce.feature.ai")}</div>

                  <div>✓ {i18n.t("billingCommerce.feature.multilingual")}</div>

                  <div>✓ {i18n.t("billingCommerce.feature.analytics")}</div>

                  <div>
                    ✓ {i18n.t("billingCommerce.feature.noWhatsappBill")}
                  </div>
                </div>

                <div className="moda-plan-allowance">
                  <strong>{plan.includedConversations}</strong>

                  <span>
                    {plan.allowanceType === "lifetime"
                      ? i18n.t("billingCommerce.plans.freeLifetime")
                      : i18n.t("billingCommerce.plans.monthly")}
                  </span>
                </div>

                <div className="moda-plan-benefits">
                  <div>✓ {i18n.t("billingCommerce.feature.ai")}</div>

                  <div>✓ {i18n.t("billingCommerce.feature.multilingual")}</div>

                  <div>✓ {i18n.t("billingCommerce.feature.analytics")}</div>

                  <div>
                    ✓ {i18n.t("billingCommerce.feature.noWhatsappBill")}
                  </div>
                </div>

                {isCurrent ? (
                  <button
                    className="moda-action-button moda-action-button-current"
                    type="button"
                    disabled
                  >
                    {i18n.t("billingCommerce.plans.currentButton")}
                  </button>
                ) : (
                  <button
                    className={`moda-action-button ${
                      isUpgrade
                        ? "moda-action-button-primary"
                        : "moda-action-button-secondary"
                    }`}
                    type="button"
                    onClick={() => {
                      console.log("PLAN CHANGE SELECTED:", plan);

                      onChangePlan?.(plan);
                    }}
                  >
                    {i18n.t(
                      isUpgrade
                        ? "billingCommerce.plans.upgradeAction"
                        : "billingCommerce.plans.downgradeAction",
                    )}{" "}
                    {plan.name}
                  </button>
                )}
              </article>
            );
          })}
      </div>
    </section>
  );
}

SubscriptionChangePanel.propTypes = {
  merchantUi: PropTypes.shape({
    locale: PropTypes.string,
    timeZone: PropTypes.string,
  }),

  currentPlanId: PropTypes.string.isRequired,

  plans: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      rank: PropTypes.number.isRequired,
      monthlyPriceMinor: PropTypes.number.isRequired,
      currency: PropTypes.string,
      includedConversations: PropTypes.number.isRequired,
      allowanceType: PropTypes.oneOf(["monthly", "lifetime"]).isRequired,
    }),
  ).isRequired,

  onChangePlan: PropTypes.func,
};
