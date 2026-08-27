import RecoveryChart from "./RecoveryChart";
import PropTypes from "prop-types";

export default function Stats({
  abandonedCheckouts = 0,
  recoveredCheckouts = 0,
  recoveredRevenue = 0,
  messagesSent = 0,
  recoveries = [],
}) {
  const recoveryRate =
    abandonedCheckouts > 0
      ? ((recoveredCheckouts / abandonedCheckouts) * 100).toFixed(1)
      : "0.0";

  const formattedRevenue = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(recoveredRevenue);

  const stats = [
    {
      label: "Abandoned checkouts",
      value: abandonedCheckouts,
    },
    {
      label: "Recovered checkouts",
      value: recoveredCheckouts,
    },
    {
      label: "Recovery rate",
      value: `${recoveryRate}%`,
    },
    {
      label: "Recovered revenue",
      value: formattedRevenue,
    },
    {
      label: "Messages sent",
      value: messagesSent,
    },
  ];

  return (
    <>
      <s-section heading="Performance">
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

      <RecoveryChart recoveries={recoveries} />
    </>
  );
}

Stats.propTypes = {
  abandonedCheckouts: PropTypes.number,
  recoveredCheckouts: PropTypes.number,
  recoveredRevenue: PropTypes.number,
  messagesSent: PropTypes.number,
  recoveries: PropTypes.arrayOf(PropTypes.object),
};