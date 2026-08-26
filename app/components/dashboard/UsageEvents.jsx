import PropTypes from "prop-types";
import { useSearchParams } from "react-router";

const metricLabels = {
  checkout_recovery: "Checkout recovery",
  conversation: "Conversation",
  agent_message: "Agent message",
  whatsapp_message: "WhatsApp message",
};

export default function UsageEvents({ usageEvents, usagePagination, usageView, billingPeriods }) {
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
    <s-section heading="Billable usage">
      {usageView === "past" && <label className="usage-bill-select" htmlFor="usage-bill-select">
        <span>Select a past bill</span>
        <select id="usage-bill-select" value={usagePagination.billId ?? ""} onChange={(event) => { const nextParams = new URLSearchParams(searchParams); nextParams.set("billId", event.target.value); nextParams.set("page", "1"); setSearchParams(nextParams, { preventScrollReset: true }); }}>
          {billingPeriods.filter((period) => period.status === "PAID").map((period) => <option key={period.id} value={period.id}>{new Date(period.periodStart).toLocaleDateString("en-GB", { month: "long", year: "numeric" })} · {period.totalQuantity} actions</option>)}
        </select>
      </label>}
      <s-stack direction="inline" gap="base" alignment="center" className="usage-toolbar">
        <s-text>{totalQuantity} actions recorded across {total} events</s-text>
        <label className="usage-page-size" htmlFor="usage-page-size">
          <span>Rows per page</span>
          <select id="usage-page-size" value={pageSize} onChange={(event) => updatePagination(1, Number(event.target.value))}>
          {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size} per page</option>)}
          </select>
        </label>
      </s-stack>
      <table className="dashboard-table" style={{ marginTop: "16px" }}>
        <thead><tr><th align="left">Action</th><th align="left">Recovery</th><th align="left">Customer</th><th align="left">Quantity</th><th align="left">Idempotency key</th><th align="left">Recorded</th></tr></thead>
        <tbody>{usageEvents.map((event) => (
          <tr key={event.id}>
            <td>{metricLabels[event.metric] ?? event.metric}</td>
            <td>{event.sourceRecovery?.recoveryId ?? "Unlinked"}</td>
            <td>{event.sourceRecovery?.customerName ?? "Unlinked"}</td>
            <td>{event.quantity}</td>
            <td><code>{event.idempotencyKey}</code></td>
            <td>{new Date(event.occurredAt).toLocaleDateString("en-GB")}</td>
          </tr>
        ))}</tbody>
      </table>
      <s-stack direction="inline" gap="base" alignment="center" className="usage-pagination">
        <s-text className="usage-range">{firstItem}-{lastItem} of {total}</s-text>
        <button className="usage-page-button" type="button" disabled={page <= 1} onClick={() => updatePagination(page - 1)}>Previous</button>
        <button className="usage-page-button" type="button" disabled={page >= totalPages} onClick={() => updatePagination(page + 1)}>Next</button>
      </s-stack>
    </s-section>
  );
}

UsageEvents.propTypes = {
  usageEvents: PropTypes.arrayOf(PropTypes.object),
  usagePagination: PropTypes.object,
  usageView: PropTypes.string,
  billingPeriods: PropTypes.arrayOf(PropTypes.object),
};