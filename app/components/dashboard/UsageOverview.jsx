import { arc, pie, scaleOrdinal, schemeTableau10 } from "d3";
import PropTypes from "prop-types";
import { Link, useNavigate } from "react-router";
import Breadcrumbs from "./Breadcrumbs";
import PendingRecoveries from "./PendingRecoveries";
import { createMerchantI18n } from "../../utils/merchant-i18n";

const colors = scaleOrdinal(schemeTableau10);
const metricKeys = { checkout_recovery: "chart.metricCheckoutRecovery", conversation: "chart.metricConversation", agent_message: "chart.metricAgentMessage", whatsapp_message: "chart.metricWhatsappMessage" };

function UsagePie({ title, events, i18n }) {
  const grouped = Object.entries(events.reduce((groups, event) => { groups[event.metric] = (groups[event.metric] ?? 0) + event.quantity; return groups; }, {})).map(([metric, value]) => ({ metric, value }));
  const slices = pie().value((item) => item.value).sort(null)(grouped);
  const createArc = arc().innerRadius(52).outerRadius(92);
  const total = grouped.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="usage-overview-card">
      <h3>{title}</h3>
      <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label={i18n.t("usage.chartBreakdown", { title })}>
        <g transform="translate(110,110)">
          {slices.map((slice) => <path key={slice.data.metric} d={createArc(slice)} fill={colors(slice.data.metric)} />)}
          <text textAnchor="middle" dy="-3" fontSize="25" fontWeight="700">{total}</text>
          <text textAnchor="middle" dy="18" fontSize="12" fill="#616161">{i18n.t("usage.actions", { quantity: total })}</text>
        </g>
      </svg>
      <div className="usage-overview-legend">
        {grouped.map((item) => <div key={item.metric}><span className="usage-legend-dot" style={{ background: colors(item.metric) }} />{i18n.t(metricKeys[item.metric] ?? "common.unavailable")}<strong>{i18n.formatNumber(item.value)}</strong></div>)}
        {grouped.length === 0 && <span className="usage-overview-empty">{i18n.t("usage.noRecorded")}</span>}
      </div>
    </div>
  );
}

export default function UsageOverview({ usageSummary, billingPeriods, pendingRecoveries, pendingRecoveriesUpdatedAt, merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);
  const navigate = useNavigate();
  const pastPeriods = billingPeriods.filter((period) => period.status === "CLOSED");
  return (
    <s-page heading={i18n.t("usage.title")}>
      <Breadcrumbs current={i18n.t("usage.title")} merchantUi={merchantUi} />

      <s-section>
               <div className="usage-overview-grid">
        <s-heading>{i18n.t("billing.currentPlan")}</s-heading>

        {/* existing billing information */}

        <s-button href="/app/billing/options" variant="primary">
          {i18n.t("billingCommerce.actions.manageCapacity")}
        </s-button>
      </div>
      </s-section>
      <s-section>
        <div className="usage-overview-grid">
          <div className="usage-overview-column">
            <UsagePie title={i18n.t("usage.current")} events={usageSummary.current} i18n={i18n} />
            <Link className="usage-detail-link" to="/app?view=detail&bill=current">{i18n.t("usage.viewCurrent")}</Link>
          </div>
          <div className="usage-overview-column">
            <UsagePie title={i18n.t("usage.past")} events={usageSummary.past} i18n={i18n} />
            <label className="overview-bill-select" htmlFor="overview-bill-select">
              <span>{i18n.t("usage.selectPast")}</span>
              <select id="overview-bill-select" defaultValue="" onChange={(event) => { if (event.target.value) navigate(`/app?view=detail&bill=past&billId=${event.target.value}`); }}>
                <option value="">{i18n.t("usage.selectPastPlaceholder")}</option>
                {pastPeriods.map((period) => <option key={period.id} value={period.id}>{i18n.formatDate(period.periodStart, { day: undefined, month: "long", year: "numeric" })}</option>)}
              </select>
            </label>
          </div>
        </div>
      </s-section>
      <PendingRecoveries pendingRecoveries={pendingRecoveries} pendingRecoveriesUpdatedAt={pendingRecoveriesUpdatedAt} merchantUi={merchantUi} />
    </s-page>
  );
}

UsagePie.propTypes = { title: PropTypes.string, events: PropTypes.arrayOf(PropTypes.object), i18n: PropTypes.shape({ t: PropTypes.func, formatNumber: PropTypes.func }) };
UsageOverview.propTypes = { usageSummary: PropTypes.object, billingPeriods: PropTypes.arrayOf(PropTypes.object), pendingRecoveries: PropTypes.object, pendingRecoveriesUpdatedAt: PropTypes.string, merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }) };