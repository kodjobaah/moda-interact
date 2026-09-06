import RecoveryChart from "./RecoveryChart";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

export default function Stats({
  abandonedCheckouts = 0,
  recoveredCheckouts = 0,
  messagesSent = 0,
  recoveries = [],
  recoveredRevenueByCurrency = {},
  merchantUi,
}) {
  const i18n = createMerchantI18n(merchantUi);
  const recoveryRate =
    abandonedCheckouts > 0
      ? ((recoveredCheckouts / abandonedCheckouts) * 100).toFixed(1)
      : "0.0";

  const formattedRevenue = Object.entries(recoveredRevenueByCurrency).map(([currency, value]) => i18n.formatMoney(value, currency)).join(", ") || i18n.t("common.unavailable");

  const stats = [
    {
      label: i18n.t("dashboard.abandonedCheckouts"),
      value: abandonedCheckouts,
    },
    {
      label: i18n.t("dashboard.recoveredCheckouts"),
      value: recoveredCheckouts,
    },
    {
      label: i18n.t("dashboard.recoveryRate"),
      value: i18n.formatPercent(Number(recoveryRate) / 100),
    },
    {
      label: i18n.t("dashboard.recoveredRevenue"),
      value: formattedRevenue,
    },
    {
      label: i18n.t("dashboard.messagesSent"),
      value: messagesSent,
    },
  ];

  return (
    <>
      <s-section heading={i18n.t("dashboard.performance")}>
      <s-stack direction="inline" gap="base">
        {stats.map((stat) => (
          <s-box
            key={stat.label}
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack direction="block" gap="small">
              <s-text>{stat.label}</s-text>

              <s-heading>{stat.value}</s-heading>
            </s-stack>
          </s-box>
        ))}
      </s-stack>
      </s-section>

      <RecoveryChart recoveries={recoveries} merchantUi={merchantUi} />
    </>
  );
}

Stats.propTypes = {
  abandonedCheckouts: PropTypes.number,
  recoveredCheckouts: PropTypes.number,
  recoveredRevenue: PropTypes.number,
  messagesSent: PropTypes.number,
  recoveries: PropTypes.arrayOf(PropTypes.object),
  recoveredRevenueByCurrency: PropTypes.object,
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};