import Stats from "@/components/dashboard/Stats";
import PropTypes from "prop-types";
import Breadcrumbs from "./Breadcrumbs";

export default function Dashboard({ stats, recoveries, usageEvents, usagePagination, usageView, billingPeriods }) {
  const periodLabel = usagePagination.periodStart && usagePagination.periodEnd
    ? `${new Date(usagePagination.periodStart).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} - ${new Date(usagePagination.periodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
    : "Billing period";

  return (
    <s-page heading="Moda Interact">
      <Breadcrumbs current={periodLabel} />
      <div className="billing-period-header">
        <span className="billing-period-label">Billing period</span>
        <strong>{periodLabel}</strong>
      </div>
      <Stats {...stats} recoveries={recoveries} usageEvents={usageEvents} usagePagination={usagePagination} usageView={usageView} billingPeriods={billingPeriods} />
    </s-page>
  );
}

Dashboard.propTypes = {
  stats: PropTypes.object,
  recoveries: PropTypes.arrayOf(PropTypes.object),
  usageEvents: PropTypes.arrayOf(PropTypes.object),
  usagePagination: PropTypes.object,
  usageView: PropTypes.string,
  billingPeriods: PropTypes.arrayOf(PropTypes.object),
};