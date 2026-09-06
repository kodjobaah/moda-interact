import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";

function pageHref(page) {
  return `/app?pendingPage=${page}`;
}

export function getPendingRecoveriesDisplayState(pendingRecoveries, pendingRecoveriesUpdatedAt) {
  return {
    displayData: pendingRecoveries,
    lastUpdated: pendingRecoveries?.available ? pendingRecoveriesUpdatedAt : null,
  };
}

export default function PendingRecoveries({ pendingRecoveries, pendingRecoveriesUpdatedAt, merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);
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
      <s-section heading={i18n.t("pending.title")}>
        <div className="pending-recoveries-header">
          <span>{i18n.t("pending.unavailable")}</span>
          <button type="button" onClick={refresh} disabled={isRefreshing}>{isRefreshing ? i18n.t("pending.refreshing") : i18n.t("pending.refresh")}</button>
        </div>
        <p className="pending-recoveries-message" dir={i18n.direction}>{i18n.t("pending.unavailableMessage")}</p>
      </s-section>
    );
  }

  const { items, page, total, totalPages } = displayData;
  return (
    <s-section heading={i18n.t("pending.title")}>
      <div className="pending-recoveries-header">
        <div>
          <span>{i18n.t("pending.active", { count: total })}</span>
          <span className="pending-recoveries-updated">{i18n.t("pending.lastUpdated", { time: lastUpdated ? i18n.formatTime(lastUpdated) : i18n.t("common.unavailable") })}</span>
        </div>
        <button type="button" onClick={refresh} disabled={isRefreshing}>{isRefreshing ? i18n.t("pending.refreshing") : i18n.t("pending.refresh")}</button>
      </div>
      {items.length === 0 ? (
        <p className="pending-recoveries-message" dir={i18n.direction}>{i18n.t("pending.empty")}</p>
      ) : (
        <div className="pending-recoveries-table-wrap">
          <table className="pending-recoveries-table">
            <thead>
              <tr>
                <th scope="col">{i18n.t("pending.lastActivity")}</th>
                <th scope="col">{i18n.t("pending.scheduled")}</th>
                <th scope="col">{i18n.t("pending.status")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.lastActivityAt ? i18n.formatDateTime(item.lastActivityAt) : i18n.t("common.unavailable")}</td>
                  <td>{i18n.formatDateTime(item.scheduledFor)}</td>
                  <td><span className={`pending-recovery-status pending-recovery-status-${item.status}`}>{i18n.t(`pending.${item.status}Status`)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <nav className="pending-recoveries-pagination" aria-label={i18n.t("pending.title")}>
          {page > 1 ? <Link to={pageHref(page - 1)}>{i18n.t("pending.previous")}</Link> : <span aria-disabled="true">{i18n.t("pending.previous")}</span>}
          <span>{i18n.t("pending.page", { page: i18n.formatNumber(page), totalPages: i18n.formatNumber(totalPages) })}</span>
          {page < totalPages ? <Link to={pageHref(page + 1)}>{i18n.t("pending.next")}</Link> : <span aria-disabled="true">{i18n.t("pending.next")}</span>}
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
      lastActivityAt: PropTypes.string,
      scheduledFor: PropTypes.string,
    })),
  }),
  pendingRecoveriesUpdatedAt: PropTypes.string,
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};
