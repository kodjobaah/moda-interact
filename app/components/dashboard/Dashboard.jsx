import Stats from "@/components/dashboard/Stats";
import PropTypes from "prop-types";
import { Link } from "react-router";
import Breadcrumbs from "./Breadcrumbs";
import { createMerchantI18n } from "../../utils/merchant-i18n";

export default function Dashboard({ stats, recoveries, usageView, usagePagination, merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);
  const usageUrl = `/app/usage?bill=${usageView}${usagePagination.billId ? `&billId=${usagePagination.billId}` : ""}`;
  const periodLabel = usagePagination.periodStart && usagePagination.periodEnd
    ? `${i18n.formatDate(usagePagination.periodStart)} - ${i18n.formatDate(usagePagination.periodEnd)}`
    : i18n.t("dashboard.billingPeriod");

  return (
    <s-page heading="Moda Interact">
      <Breadcrumbs current={periodLabel} merchantUi={merchantUi} />
      <Stats {...stats} recoveries={recoveries} merchantUi={merchantUi} />
      <Link className="usage-detail-link dashboard-usage-link" to={usageUrl}>{i18n.t("dashboard.viewAllUsage")}</Link>
    </s-page>
  );
}

Dashboard.propTypes = {
  stats: PropTypes.object,
  recoveries: PropTypes.arrayOf(PropTypes.object),
  usageView: PropTypes.string,
  usagePagination: PropTypes.object,
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};