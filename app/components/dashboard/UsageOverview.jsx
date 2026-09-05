import { arc, pie, scaleOrdinal, schemeTableau10 } from "d3";
import PropTypes from "prop-types";
import { Link, useNavigate } from "react-router";
import Breadcrumbs from "./Breadcrumbs";
import PendingRecoveries from "./PendingRecoveries";

const colors = scaleOrdinal(schemeTableau10);
const metricLabels = { checkout_recovery: "Checkout recovery", conversation: "Conversation", agent_message: "Agent message", whatsapp_message: "WhatsApp message" };

function UsagePie({ title, events }) {
  const grouped = Object.entries(events.reduce((groups, event) => { groups[event.metric] = (groups[event.metric] ?? 0) + event.quantity; return groups; }, {})).map(([metric, value]) => ({ metric, value }));
  const slices = pie().value((item) => item.value).sort(null)(grouped);
  const createArc = arc().innerRadius(52).outerRadius(92);
  const total = grouped.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="usage-overview-card">
      <h3>{title}</h3>
      <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label={`${title} billable usage breakdown`}>
        <g transform="translate(110,110)">
          {slices.map((slice) => <path key={slice.data.metric} d={createArc(slice)} fill={colors(slice.data.metric)} />)}
          <text textAnchor="middle" dy="-3" fontSize="25" fontWeight="700">{total}</text>
          <text textAnchor="middle" dy="18" fontSize="12" fill="#616161">actions</text>
        </g>
      </svg>
      <div className="usage-overview-legend">
        {grouped.map((item) => <div key={item.metric}><span className="usage-legend-dot" style={{ background: colors(item.metric) }} />{metricLabels[item.metric] ?? item.metric}<strong>{item.value}</strong></div>)}
        {grouped.length === 0 && <span className="usage-overview-empty">No usage recorded</span>}
      </div>
    </div>
  );
}

export default function UsageOverview({ usageSummary, billingPeriods, pendingRecoveries, pendingRecoveriesUpdatedAt }) {
  const navigate = useNavigate();
  const pastPeriods = billingPeriods.filter((period) => period.status === "PAID");
  return (
    <s-page heading="Usage overview">
      <Breadcrumbs current="Usage overview" />
      <s-section>
        <div className="usage-overview-grid">
          <div className="usage-overview-column">
            <UsagePie title="Current usage" events={usageSummary.current} />
            <Link className="usage-detail-link" to="/app?view=detail&bill=current">View current bill</Link>
          </div>
          <div className="usage-overview-column">
            <UsagePie title="Past paid usage" events={usageSummary.past} />
            <label className="overview-bill-select" htmlFor="overview-bill-select">
              <span>View a past monthly bill</span>
              <select id="overview-bill-select" defaultValue="" onChange={(event) => { if (event.target.value) navigate(`/app?view=detail&bill=past&billId=${event.target.value}`); }}>
                <option value="">Select a past bill</option>
                {pastPeriods.map((period) => <option key={period.id} value={period.id}>{new Date(period.periodStart).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</option>)}
              </select>
            </label>
          </div>
        </div>
      </s-section>
      <PendingRecoveries pendingRecoveries={pendingRecoveries} pendingRecoveriesUpdatedAt={pendingRecoveriesUpdatedAt} />
    </s-page>
  );
}

UsagePie.propTypes = { title: PropTypes.string, events: PropTypes.arrayOf(PropTypes.object) };
UsageOverview.propTypes = { usageSummary: PropTypes.object, billingPeriods: PropTypes.arrayOf(PropTypes.object), pendingRecoveries: PropTypes.object, pendingRecoveriesUpdatedAt: PropTypes.string };