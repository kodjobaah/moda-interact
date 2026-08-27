import Stats from "@/components/dashboard/Stats";
import PropTypes from "prop-types";
import { Link } from "react-router";
import Breadcrumbs from "./Breadcrumbs";

export default function Dashboard({ stats, recoveries, usageView, usagePagination }) {
  const usageUrl = `/app/usage?bill=${usageView}${usagePagination.billId ? `&billId=${usagePagination.billId}` : ""}`;
  const periodLabel = usagePagination.periodStart && usagePagination.periodEnd
    ? `${new Date(usagePagination.periodStart).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} - ${new Date(usagePagination.periodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
    : "Billing period";

  return (
    <s-page heading="Moda Interact">
      <Breadcrumbs current={periodLabel} />
      <Stats {...stats} recoveries={recoveries} />
      <Link className="usage-detail-link dashboard-usage-link" to={usageUrl}>View all usage for this bill</Link>
    </s-page>
  );
}

Dashboard.propTypes = {
  stats: PropTypes.object,
  recoveries: PropTypes.arrayOf(PropTypes.object),
  usageView: PropTypes.string,
  usagePagination: PropTypes.object,
};