import { arc, pie, scaleOrdinal, schemeTableau10 } from "d3";
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

const statusKeys = { COMPLETED: "chart.statusRecovered", ENGAGED: "chart.statusEngaged", MESSAGE_SENT: "chart.statusMessageSent", DETECTED: "chart.statusDetected", EXPIRED: "chart.statusExpired", CANCELLED: "chart.statusCancelled" };
const colors = scaleOrdinal(schemeTableau10);
const metricKeys = { checkout_recovery: "chart.metricCheckoutRecovery", conversation: "chart.metricConversation", agent_message: "chart.metricAgentMessage", whatsapp_message: "chart.metricWhatsappMessage" };
const senderKeys = { CUSTOMER: "chart.senderCustomer", AGENT: "chart.senderAgent" };
const messageStatusKeys = { SENT: "chart.statusSent", DELIVERED: "chart.statusDelivered", FAILED: "chart.statusFailed" };

export function groupRecoveriesByCustomer(recoveries) {
  return Object.values(recoveries.reduce((groups, recovery) => {
    const customerId = recovery.customer?.id ?? `guest-${recovery.id}`;
    const customer = groups[customerId] ?? { id: customerId, customer: recovery.customer, recoveries: [], totalsByCurrency: {}, messageCount: 0 };
    customer.recoveries.push(recovery);
    if (recovery.currency) customer.totalsByCurrency[recovery.currency] = (customer.totalsByCurrency[recovery.currency] ?? 0) + recovery.totalPrice;
    customer.messageCount += recovery.messageCount;
    groups[customerId] = customer;
    return groups;
  }, {}));
}

export default function RecoveryChart({ recoveries, merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [selectedRecoveryId, setSelectedRecoveryId] = useState(null);
  const [customerPage, setCustomerPage] = useState(1);
  const customersPerPage = 10;
  const grouped = Object.entries(recoveries.reduce((groups, recovery) => { groups[recovery.status] = (groups[recovery.status] ?? 0) + 1; return groups; }, {})).map(([status, value]) => ({ status, value }));
  const pieData = pie().value((item) => item.value).sort(null)(grouped);
  const createArc = arc().innerRadius(58).outerRadius(105);
  const selectedRows = selectedStatus ? recoveries.filter((recovery) => recovery.status === selectedStatus) : recoveries;
  const customers = groupRecoveriesByCustomer(selectedRows);
  const selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId);
  const selectedRecovery = recoveries.find((recovery) => recovery.id === selectedRecoveryId);
  const customerTotalPages = Math.max(1, Math.ceil(customers.length / customersPerPage));
  const customerFirstItem = customers.length === 0 ? 0 : (customerPage - 1) * customersPerPage + 1;
  const customerLastItem = Math.min(customerPage * customersPerPage, customers.length);
  const paginatedCustomers = customers.slice((customerPage - 1) * customersPerPage, customerPage * customersPerPage);
  const formatMoney = (recovery) => recovery.currency ? i18n.formatMoney(recovery.totalPrice, recovery.currency) : i18n.t("common.unavailable");
  const formatMoneyList = (totalsByCurrency) => Object.entries(totalsByCurrency).map(([currency, value]) => i18n.formatMoney(value, currency)).join(", ") || i18n.t("common.unavailable");
  const statusLabel = (status) => i18n.t(statusKeys[status] ?? "common.unavailable");
  const metricLabel = (metric) => i18n.t(metricKeys[metric] ?? "common.unavailable");
  const senderLabel = (sender) => i18n.t(senderKeys[sender] ?? "common.unavailable");
  const messageStatusLabel = (status) => i18n.t(messageStatusKeys[status] ?? "common.unavailable");

  useEffect(() => {
    if (!selectedCustomer) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setSelectedCustomerId(null);
        setSelectedRecoveryId(null);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [selectedCustomer]);

  useEffect(() => {
    setCustomerPage(1);
  }, [selectedStatus]);

  return (
    <s-section heading={i18n.t("chart.recoveryBreakdown")}>
      <s-stack direction="inline" gap="base" alignment="center">
        <svg viewBox="0 0 240 240" width="240" height="240" role="img" aria-label={i18n.t("chart.recoveryBreakdown")}>
          <g transform="translate(120,120)">
            {pieData.map((slice) => <path key={slice.data.status} d={createArc(slice)} fill={colors(slice.data.status)} opacity={selectedStatus && selectedStatus !== slice.data.status ? 0.35 : 1} onClick={() => setSelectedStatus(selectedStatus === slice.data.status ? null : slice.data.status)} style={{ cursor: "pointer", transition: "opacity 160ms ease" }} />)}
            <text textAnchor="middle" dy="-4" fontSize="26" fontWeight="700">{customers.length}</text>
            <text textAnchor="middle" dy="18" fontSize="12" fill="#616161">{selectedStatus ? statusLabel(selectedStatus) : i18n.t("chart.customers")}</text>
          </g>
        </svg>
        <s-stack direction="block" gap="small">
          {grouped.map((item) => <button key={item.status} type="button" onClick={() => setSelectedStatus(selectedStatus === item.status ? null : item.status)} style={{ display: "flex", alignItems: "center", gap: "8px", border: 0, background: "transparent", padding: "4px", cursor: "pointer" }}><span aria-hidden="true" style={{ width: "10px", height: "10px", background: colors(item.status), borderRadius: "50%" }} /><span>{statusLabel(item.status)}</span><strong>{item.value}</strong></button>)}
        </s-stack>
      </s-stack>
      <table className="dashboard-table" style={{ marginTop: "24px" }}>
        <thead><tr><th>{i18n.t("usage.customer")}</th><th>{i18n.t("chart.recoveries", { count: 2 })}</th><th>{i18n.t("chart.totalValue")}</th><th>{i18n.t("chart.latestCheckout")}</th><th>{i18n.t("chart.messages", { count: 2 })}</th></tr></thead>
        <tbody>{paginatedCustomers.map((customer) => <tr key={customer.id} onClick={() => { setSelectedCustomerId(selectedCustomerId === customer.id ? null : customer.id); setSelectedRecoveryId(null); }} style={{ cursor: "pointer", background: selectedCustomerId === customer.id ? "#e3f0e8" : "transparent" }}><td>{[customer.customer?.firstName, customer.customer?.lastName].filter(Boolean).join(" ") || customer.customer?.email || i18n.t("chart.guest")}</td><td>{i18n.t("chart.recoveries", { count: customer.recoveries.length })}</td><td>{formatMoneyList(customer.totalsByCurrency)}</td><td>{i18n.formatDate(customer.recoveries[0].detectedAt)}</td><td>{i18n.t("chart.messages", { count: customer.messageCount })}</td></tr>)}</tbody>
      </table>
      <s-stack direction="inline" gap="base" alignment="center" className="usage-pagination">
        <s-text className="usage-range">{i18n.t("usage.range", { first: customerFirstItem, last: customerLastItem, total: customers.length })}</s-text>
        <button className="usage-page-button" type="button" disabled={customerPage <= 1} onClick={() => setCustomerPage(customerPage - 1)}>{i18n.t("usage.previous")}</button>
        <button className="usage-page-button" type="button" disabled={customerPage >= customerTotalPages} onClick={() => setCustomerPage(customerPage + 1)}>{i18n.t("usage.next")}</button>
      </s-stack>
      {selectedCustomer && <div className="customer-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelectedCustomerId(null); setSelectedRecoveryId(null); } }}>
        <div className="customer-dialog" role="dialog" aria-modal="true" aria-labelledby="customer-dialog-title">
          <div className="customer-dialog-header">
            <div>
              <span className="customer-dialog-kicker">{i18n.t("chart.customerInteractions")}</span>
              <h2 id="customer-dialog-title">{[selectedCustomer.customer?.firstName, selectedCustomer.customer?.lastName].filter(Boolean).join(" ") || i18n.t("chart.guest")}</h2>
              <p>{i18n.t("chart.recoveries", { count: selectedCustomer.recoveries.length })} · {i18n.t("chart.messages", { count: selectedCustomer.messageCount })} · {formatMoneyList(selectedCustomer.totalsByCurrency)} {i18n.t("chart.totalValue")}</p>
            </div>
            <button className="customer-dialog-close" type="button" aria-label={i18n.t("chart.closeLabel")} onClick={() => { setSelectedCustomerId(null); setSelectedRecoveryId(null); }}>{i18n.t("chart.close")}</button>
          </div>
          <div className="customer-dialog-body">
        <div className="recovery-picker">
          <label htmlFor="recovery-select">{i18n.t("chart.selectRecovery")}</label>
          <span className="recovery-picker-hint">{i18n.t("chart.chooseCheckout")}</span>
        <select className="recovery-select" id="recovery-select" value={selectedRecoveryId ?? ""} onChange={(event) => setSelectedRecoveryId(event.target.value || null)}>
          <option value="">{i18n.t("chart.selectRecoveryPlaceholder")}</option>
          {selectedCustomer.recoveries.map((recovery) => <option key={recovery.id} value={recovery.id}>{recovery.id} · {statusLabel(recovery.status)} · {formatMoney(recovery)}</option>)}
        </select>
        </div>
      {selectedRecovery && <div className="customer-dialog-details">
        <div className="customer-dialog-section-heading"><h3>{i18n.t("chart.recoveryDetails")}</h3><span>{i18n.t("chart.messagesRecorded", { count: selectedRecovery.messages.length })}</span></div>
        <table className="dashboard-table" style={{ marginTop: "16px" }}>
          <thead><tr><th>{i18n.t("chart.recovery")}</th><th>{i18n.t("chart.status")}</th><th>{i18n.t("chart.value")}</th><th>{i18n.t("chart.detected")}</th><th>{i18n.t("chart.conversation")}</th></tr></thead>
          <tbody><tr><td>{selectedRecovery.id}</td><td>{statusLabel(selectedRecovery.status)}</td><td>{formatMoney(selectedRecovery)}</td><td>{i18n.formatDate(selectedRecovery.detectedAt)}</td><td>{selectedRecovery.conversations.map((conversation) => conversation.type).join(", ")}</td></tr></tbody>
        </table>
        <table className="dashboard-table" style={{ marginTop: "16px" }}>
          <thead><tr><th>{i18n.t("chart.message")}</th><th>{i18n.t("chart.sender")}</th><th>{i18n.t("chart.status")}</th><th>{i18n.t("chart.sent")}</th></tr></thead>
          <tbody>{selectedRecovery.messages.map((message) => <tr key={message.id}><td dir="auto">{message.content}</td><td>{senderLabel(message.senderType)}</td><td>{messageStatusLabel(message.status)}</td><td>{i18n.formatDateTime(message.createdAt)}</td></tr>)}</tbody>
        </table>
        <table className="dashboard-table" style={{ marginTop: "16px" }}>
          <thead><tr><th>{i18n.t("chart.action")}</th><th>{i18n.t("chart.quantity")}</th><th>{i18n.t("chart.idempotencyKey")}</th><th>{i18n.t("chart.recorded")}</th></tr></thead>
          <tbody>{selectedRecovery.billableActions.map((event) => <tr key={event.id}><td>{metricLabel(event.metric)}</td><td>{event.quantity}</td><td><code>{event.idempotencyKey}</code></td><td>{i18n.formatDate(event.occurredAt)}</td></tr>)}</tbody>
        </table>
      </div>}
          </div>
        </div>
      </div>}
    </s-section>
  );
}

RecoveryChart.propTypes = {
  recoveries: PropTypes.arrayOf(PropTypes.object),
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};