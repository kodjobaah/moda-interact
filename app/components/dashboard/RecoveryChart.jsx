import { arc, pie, scaleOrdinal, schemeTableau10 } from "d3";
import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";

const statusLabels = { COMPLETED: "Recovered", ENGAGED: "Engaged", MESSAGE_SENT: "Message sent", DETECTED: "Detected", EXPIRED: "Expired", CANCELLED: "Cancelled" };
const colors = scaleOrdinal(schemeTableau10);
const metricLabels = { checkout_recovery: "Checkout recovery", conversation: "Conversation", agent_message: "Agent message", whatsapp_message: "WhatsApp message" };

export default function RecoveryChart({ recoveries }) {
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [selectedRecoveryId, setSelectedRecoveryId] = useState(null);
  const customerSummaryRef = useRef(null);
  const grouped = Object.entries(recoveries.reduce((groups, recovery) => { groups[recovery.status] = (groups[recovery.status] ?? 0) + 1; return groups; }, {})).map(([status, value]) => ({ status, value }));
  const pieData = pie().value((item) => item.value).sort(null)(grouped);
  const createArc = arc().innerRadius(58).outerRadius(105);
  const selectedRows = selectedStatus ? recoveries.filter((recovery) => recovery.status === selectedStatus) : recoveries;
  const customers = Object.values(selectedRows.reduce((groups, recovery) => {
    const customerId = recovery.customer?.id ?? `guest-${recovery.id}`;
    const customer = groups[customerId] ?? { id: customerId, customer: recovery.customer, recoveries: [], totalPrice: 0, messageCount: 0 };
    customer.recoveries.push(recovery);
    customer.totalPrice += recovery.totalPrice;
    customer.messageCount += recovery.messageCount;
    groups[customerId] = customer;
    return groups;
  }, {}));
  const selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId);
  const selectedRecovery = recoveries.find((recovery) => recovery.id === selectedRecoveryId);
  const formatMoney = (recovery) => new Intl.NumberFormat("en-GB", { style: "currency", currency: recovery.currency }).format(recovery.totalPrice);

  useEffect(() => {
    if (selectedCustomerId && customerSummaryRef.current) {
      customerSummaryRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedCustomerId]);

  return (
    <s-section heading="Recovery breakdown">
      <s-stack direction="inline" gap="base" alignment="center">
        <svg viewBox="0 0 240 240" width="240" height="240" role="img" aria-label="Checkout recovery status breakdown">
          <g transform="translate(120,120)">
            {pieData.map((slice) => <path key={slice.data.status} d={createArc(slice)} fill={colors(slice.data.status)} opacity={selectedStatus && selectedStatus !== slice.data.status ? 0.35 : 1} onClick={() => setSelectedStatus(selectedStatus === slice.data.status ? null : slice.data.status)} style={{ cursor: "pointer", transition: "opacity 160ms ease" }} />)}
            <text textAnchor="middle" dy="-4" fontSize="26" fontWeight="700">{customers.length}</text>
            <text textAnchor="middle" dy="18" fontSize="12" fill="#616161">{selectedStatus ? statusLabels[selectedStatus] : "Customers"}</text>
          </g>
        </svg>
        <s-stack direction="block" gap="small">
          {grouped.map((item) => <button key={item.status} type="button" onClick={() => setSelectedStatus(selectedStatus === item.status ? null : item.status)} style={{ display: "flex", alignItems: "center", gap: "8px", border: 0, background: "transparent", padding: "4px", cursor: "pointer", textAlign: "left" }}><span aria-hidden="true" style={{ width: "10px", height: "10px", background: colors(item.status), borderRadius: "50%" }} /><span>{statusLabels[item.status] ?? item.status}</span><strong>{item.value}</strong></button>)}
        </s-stack>
      </s-stack>
      <table className="dashboard-table" style={{ marginTop: "24px" }}>
        <thead><tr><th align="left">Customer</th><th align="left">Recoveries</th><th align="left">Total value</th><th align="left">Latest checkout</th><th align="left">Messages</th></tr></thead>
        <tbody>{customers.map((customer) => <tr key={customer.id} onClick={() => { setSelectedCustomerId(selectedCustomerId === customer.id ? null : customer.id); setSelectedRecoveryId(null); }} style={{ cursor: "pointer", background: selectedCustomerId === customer.id ? "#e3f0e8" : "transparent" }}><td>{[customer.customer?.firstName, customer.customer?.lastName].filter(Boolean).join(" ") || customer.customer?.email || "Guest"}</td><td>{customer.recoveries.length}</td><td>{formatMoney({ currency: customer.recoveries[0]?.currency ?? "GBP", totalPrice: customer.totalPrice })}</td><td>{new Date(customer.recoveries[0].detectedAt).toLocaleDateString("en-GB")}</td><td>{customer.messageCount}</td></tr>)}</tbody>
      </table>
      {selectedCustomer && <div ref={customerSummaryRef} className="customer-summary-anchor"><s-section heading={`Customer summary: ${[selectedCustomer.customer?.firstName, selectedCustomer.customer?.lastName].filter(Boolean).join(" ") || "Guest"}`}>
        <s-text>{selectedCustomer.recoveries.length} recoveries · {selectedCustomer.messageCount} messages · {formatMoney({ currency: selectedCustomer.recoveries[0]?.currency ?? "GBP", totalPrice: selectedCustomer.totalPrice })} total value</s-text>
        <div className="recovery-picker">
          <label htmlFor="recovery-select">Select a recovery to view details</label>
          <span className="recovery-picker-hint">Choose one checkout from this customer</span>
        <select className="recovery-select" id="recovery-select" value={selectedRecoveryId ?? ""} onChange={(event) => setSelectedRecoveryId(event.target.value || null)}>
          <option value="">Select a recovery</option>
          {selectedCustomer.recoveries.map((recovery) => <option key={recovery.id} value={recovery.id}>{recovery.id} · {statusLabels[recovery.status] ?? recovery.status} · {formatMoney(recovery)}</option>)}
        </select>
        </div>
      </s-section></div>}
      {selectedRecovery && <s-section heading={`Recovery details: ${selectedRecovery.id}`}>
        <s-text>{[selectedRecovery.customer?.firstName, selectedRecovery.customer?.lastName].filter(Boolean).join(" ") || "Guest"} · {selectedRecovery.messages.length} messages recorded</s-text>
        <table className="dashboard-table" style={{ marginTop: "16px" }}>
          <thead><tr><th align="left">Recovery</th><th align="left">Status</th><th align="left">Value</th><th align="left">Detected</th></tr></thead>
          <tbody><tr><td>{selectedRecovery.id}</td><td>{statusLabels[selectedRecovery.status] ?? selectedRecovery.status}</td><td>{formatMoney(selectedRecovery)}</td><td>{new Date(selectedRecovery.detectedAt).toLocaleDateString("en-GB")}</td></tr></tbody>
        </table>
        <table className="dashboard-table" style={{ marginTop: "16px" }}>
          <thead><tr><th align="left">Message</th><th align="left">Sender</th><th align="left">Status</th><th align="left">Sent</th></tr></thead>
          <tbody>{selectedRecovery.messages.map((message) => <tr key={message.id}><td>{message.content}</td><td>{message.senderType}</td><td>{message.status}</td><td>{new Date(message.createdAt).toLocaleString("en-GB")}</td></tr>)}</tbody>
        </table>
        <table className="dashboard-table" style={{ marginTop: "16px" }}>
          <thead><tr><th align="left">Action</th><th align="left">Quantity</th><th align="left">Idempotency key</th><th align="left">Recorded</th></tr></thead>
          <tbody>{selectedRecovery.billableActions.map((event) => <tr key={event.id}><td>{metricLabels[event.metric] ?? event.metric}</td><td>{event.quantity}</td><td><code>{event.idempotencyKey}</code></td><td>{new Date(event.occurredAt).toLocaleDateString("en-GB")}</td></tr>)}</tbody>
        </table>
      </s-section>}
    </s-section>
  );
}

RecoveryChart.propTypes = {
  recoveries: PropTypes.arrayOf(PropTypes.object),
};