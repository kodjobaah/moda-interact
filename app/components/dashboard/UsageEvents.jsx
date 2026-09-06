import PropTypes from "prop-types";
import { useSearchParams } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";

const metricKeys = {
  checkout_recovery: "chart.metricCheckoutRecovery",
  conversation: "chart.metricConversation",
  agent_message: "chart.metricAgentMessage",
  whatsapp_message: "chart.metricWhatsappMessage",
};

export default function UsageEvents({ usageEvents, usagePagination, usageView, billingPeriods, merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);
  const [searchParams, setSearchParams] = useSearchParams();
  const { page = 1, pageSize = 10, total = 0, totalQuantity = 0 } = usagePagination;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, total);
  const updatePagination = (nextPage, nextPageSize = pageSize) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("page", String(nextPage));
    nextParams.set("pageSize", String(nextPageSize));
    setSearchParams(nextParams, { preventScrollReset: true });
  };

  return (
    <s-section heading={i18n.t("usage.billable")}>
      {usageView === "past" && <label className="usage-bill-select" htmlFor="usage-bill-select">
        <span>{i18n.t("usage.selectPastBill")}</span>
        <select id="usage-bill-select" value={usagePagination.billId ?? ""} onChange={(event) => { const nextParams = new URLSearchParams(searchParams); nextParams.set("billId", event.target.value); nextParams.set("page", "1"); setSearchParams(nextParams, { preventScrollReset: true }); }}>
          {billingPeriods.filter((period) => period.status === "PAID").map((period) => <option key={period.id} value={period.id}>{i18n.formatDate(period.periodStart, { day: undefined, month: "long", year: "numeric" })} · {i18n.t("usage.actions", { quantity: period.totalQuantity })}</option>)}
        </select>
      </label>}
      <s-stack direction="inline" gap="base" alignment="center" className="usage-toolbar">
        <s-text>{i18n.t("usage.recorded", { quantity: totalQuantity, total })}</s-text>
        <label className="usage-page-size" htmlFor="usage-page-size">
          <span>{i18n.t("usage.rowsPerPage")}</span>
          <select id="usage-page-size" value={pageSize} onChange={(event) => updatePagination(1, Number(event.target.value))}>
          {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{i18n.t("usage.perPage", { size: i18n.formatNumber(size) })}</option>)}
          </select>
        </label>
      </s-stack>
      <table className="dashboard-table" style={{ marginTop: "16px" }}>
        <thead><tr><th>{i18n.t("usage.action")}</th><th>{i18n.t("usage.recovery")}</th><th>{i18n.t("usage.customer")}</th><th>{i18n.t("usage.quantity")}</th><th>{i18n.t("usage.idempotencyKey")}</th><th>{i18n.t("usage.recordedAt")}</th></tr></thead>
        <tbody>{usageEvents.map((event) => (
          <tr key={event.id}>
            <td>{i18n.t(metricKeys[event.metric] ?? "common.unavailable")}</td>
            <td>{event.sourceRecovery?.recoveryId ?? i18n.t("usage.unlinked")}</td>
            <td>{event.sourceRecovery?.customerName ?? i18n.t("usage.unlinked")}</td>
            <td>{i18n.formatNumber(event.quantity)}</td>
            <td><code>{event.idempotencyKey}</code></td>
            <td>{i18n.formatDate(event.occurredAt)}</td>
          </tr>
        ))}</tbody>
      </table>
      <s-stack direction="inline" gap="base" alignment="center" className="usage-pagination">
        <s-text className="usage-range">{i18n.t("usage.range", { first: i18n.formatNumber(firstItem), last: i18n.formatNumber(lastItem), total: i18n.formatNumber(total) })}</s-text>
        <button className="usage-page-button" type="button" disabled={page <= 1} onClick={() => updatePagination(page - 1)}>{i18n.t("usage.previous")}</button>
        <button className="usage-page-button" type="button" disabled={page >= totalPages} onClick={() => updatePagination(page + 1)}>{i18n.t("usage.next")}</button>
      </s-stack>
    </s-section>
  );
}

UsageEvents.propTypes = {
  usageEvents: PropTypes.arrayOf(PropTypes.object),
  usagePagination: PropTypes.object,
  usageView: PropTypes.string,
  billingPeriods: PropTypes.arrayOf(PropTypes.object),
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};