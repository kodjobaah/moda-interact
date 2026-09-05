import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

const statusLabels = {
  delayed: "Scheduled",
  waiting: "Waiting",
  active: "Processing",
};

function formatDate(value) {
  if (!value) return "Not available";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(value) {
  if (!value) return "Not available";
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pageHref(page) {
  return `/app?pendingPage=${page}`;
}

export function getPendingRecoveriesDisplayState(pendingRecoveries, pendingRecoveriesUpdatedAt) {
  return {
    displayData: pendingRecoveries,
    lastUpdated: pendingRecoveries?.available ? pendingRecoveriesUpdatedAt : null,
  };
}

export default function PendingRecoveries({ pendingRecoveries, pendingRecoveriesUpdatedAt }) {
  const fetcher = useFetcher();
  const initialDisplayState = getPendingRecoveriesDisplayState(pendingRecoveries, pendingRecoveriesUpdatedAt);
  const [displayData, setDisplayData] = useState(initialDisplayState.displayData);
  const [lastUpdated, setLastUpdated] = useState(initialDisplayState.lastUpdated);

  useEffect(() => {
    const nextDisplayState = getPendingRecoveriesDisplayState(pendingRecoveries, pendingRecoveriesUpdatedAt);
    setDisplayData(nextDisplayState.displayData);
    setLastUpdated(nextDisplayState.lastUpdated);
  }, [pendingRecoveries, pendingRecoveriesUpdatedAt]);

  useEffect(() => {
    if (!fetcher.data?.pendingRecoveries) return;
    setDisplayData(fetcher.data.pendingRecoveries);
    setLastUpdated(fetcher.data.pendingRecoveries.available ? fetcher.data.refreshedAt : null);
  }, [fetcher.data]);

  const isRefreshing = fetcher.state !== "idle";
  const refreshPage = displayData?.page ?? 1;
  const refresh = () => {
    if (!isRefreshing) fetcher.load(`/app/pending-recoveries?pendingPage=${refreshPage}`);
  };

  if (!displayData?.available) {
    return (
      <s-section heading="Pending recoveries">
        <div className="pending-recoveries-header">
          <span>Unavailable</span>
          <button type="button" onClick={refresh} disabled={isRefreshing}>{isRefreshing ? "Refreshing..." : "Refresh"}</button>
        </div>
        <p className="pending-recoveries-message">Pending recovery status is temporarily unavailable.</p>
      </s-section>
    );
  }

  const { items, page, total, totalPages } = displayData;
  return (
    <s-section heading="Pending recoveries">
      <div className="pending-recoveries-header">
        <div>
          <span>{total} active</span>
          <span className="pending-recoveries-updated">Last updated {formatTime(lastUpdated)}</span>
        </div>
        <button type="button" onClick={refresh} disabled={isRefreshing}>{isRefreshing ? "Refreshing..." : "Refresh"}</button>
      </div>
      {items.length === 0 ? (
        <p className="pending-recoveries-message">No active pending recoveries.</p>
      ) : (
        <div className="pending-recoveries-table-wrap">
          <table className="pending-recoveries-table">
            <thead>
              <tr>
                <th scope="col">Checkout created</th>
                <th scope="col">Recovery scheduled</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{formatDate(item.checkoutCreatedAt)}</td>
                  <td>{formatDate(item.scheduledFor)}</td>
                  <td><span className={`pending-recovery-status pending-recovery-status-${item.status}`}>{statusLabels[item.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <nav className="pending-recoveries-pagination" aria-label="Pending recoveries pages">
          {page > 1 ? <Link to={pageHref(page - 1)}>Previous</Link> : <span aria-disabled="true">Previous</span>}
          <span>Page {page} of {totalPages}</span>
          {page < totalPages ? <Link to={pageHref(page + 1)}>Next</Link> : <span aria-disabled="true">Next</span>}
        </nav>
      )}
    </s-section>
  );
}

PendingRecoveries.propTypes = {
  pendingRecoveries: PropTypes.shape({
    available: PropTypes.bool,
    page: PropTypes.number,
    total: PropTypes.number,
    totalPages: PropTypes.number,
    items: PropTypes.arrayOf(PropTypes.shape({
      id: PropTypes.string,
      status: PropTypes.oneOf(["delayed", "waiting", "active"]),
      checkoutCreatedAt: PropTypes.string,
      scheduledFor: PropTypes.string,
    })),
  }),
  pendingRecoveriesUpdatedAt: PropTypes.string,
};
