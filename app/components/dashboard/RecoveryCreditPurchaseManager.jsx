// @ts-nocheck
/* eslint-disable react/prop-types */
/* eslint-disable jsx-a11y/no-autofocus */

import { useEffect, useMemo, useState } from "react";
import { useFetcher, useRevalidator, useSearchParams } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";

const FILTERS = ["ACTIVE", "WITHDRAWN", "COMPLETED", "REFUNDED", "ALL"];
const statusKeys = {
  REQUESTED: "requested",
  ACTIVE: "active",
  WITHDRAWN: "withdrawn",
  COMPLETED: "completed",
  REFUNDED: "refunded",
};

function eligible(purchase) {
  return purchase.status === "ACTIVE" && purchase.availableAmount > 0;
}

function outcomeText(i18n, outcome) {
  const values = {
    current: outcome.currentAmount ?? 0,
    reserved: outcome.reservedAmount ?? 0,
    available: outcome.availableAmount ?? 0,
  };
  return i18n.t(`billingPurchases.outcome.${outcome.code}`, values);
}

export default function RecoveryCreditPurchaseManager({ merchantUi, page }) {
  const i18n = createMerchantI18n(merchantUi);
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState([]);
  const [dialog, setDialog] = useState(null);
  const filter = FILTERS.includes(searchParams.get("filter")) ? searchParams.get("filter") : "ACTIVE";
  const purchases = useMemo(() => page?.purchases ?? [], [page]);
  const visible = useMemo(() => filter === "ALL" ? purchases : purchases.filter((purchase) => purchase.status === filter), [filter, purchases]);
  const eligibleVisible = visible.filter(eligible);
  const selectedPurchases = purchases.filter((purchase) => selected.includes(purchase.id) && eligible(purchase));
  const isSubmitting = fetcher.state !== "idle";
  const outcomes = Array.isArray(fetcher.data) ? fetcher.data : [];

  useEffect(() => {
    setSelected((ids) => ids.filter((id) => eligibleVisible.some((purchase) => purchase.id === id)));
  }, [eligibleVisible, filter]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && (Array.isArray(fetcher.data) || fetcher.data.code)) {
      revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, revalidator]);

  const setFilter = (nextFilter) => {
    setSelected([]);
    setSearchParams((current) => {
      current.set("filter", nextFilter);
      current.set("page", "1");
      return current;
    });
  };

  const toggle = (purchaseId) => {
    setSelected((ids) => ids.includes(purchaseId) ? ids.filter((id) => id !== purchaseId) : [...ids, purchaseId]);
  };

  const toggleAll = () => {
    const ids = eligibleVisible.map((purchase) => purchase.id);
    setSelected((current) => ids.every((id) => current.includes(id)) ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]);
  };

  const requestRefund = () => {
    if (selectedPurchases.length === 0) return;
    setDialog(null);
    const form = new FormData();
    form.set("intent", "request_refund");
    form.set("requestId", crypto.randomUUID());
    selectedPurchases.forEach((purchase) => form.append("purchaseId", purchase.id));
    fetcher.submit(form, { method: "post" });
    setSelected([]);
  };

  const reactivate = (purchaseId) => {
    setDialog(null);
    fetcher.submit({ intent: "reactivate", purchaseId }, { method: "post" });
  };

  const formatMoney = (purchase, refund = false) => {
    const money = refund && purchase.completedRefund
      ? { amount: purchase.completedRefund.expectedProviderAmount, currency: purchase.completedRefund.expectedProviderCurrency }
      : purchase.originalProviderPurchase;
    if (!money) return i18n.t("billingPurchases.notAvailable");
    return i18n.formatMoney(money.amount, money.currency);
  };

  return <section aria-labelledby="purchase-manager-title">
    <div className="moda-panel-heading-row">
      <div>
        <div className="moda-eyebrow">{i18n.t("billingPurchases.eyebrow")}</div>
        <h1 id="purchase-manager-title">{i18n.t("billingPurchases.title")}</h1>
        <p>{i18n.t("billingPurchases.description")}</p>
      </div>
    </div>
    <div role="tablist" aria-label={i18n.t("billingPurchases.filtersLabel")}>
      {FILTERS.map((value) => <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{i18n.t(`billingPurchases.filter.${value}`)}</button>)}
    </div>
    {eligibleVisible.length > 0 ? <div>
      <label><input type="checkbox" checked={eligibleVisible.every((purchase) => selected.includes(purchase.id))} onChange={toggleAll} disabled={isSubmitting} /> {i18n.t("billingPurchases.selectAll")}</label>
      <button type="button" disabled={selectedPurchases.length === 0 || isSubmitting} onClick={() => setDialog({ type: "refund" })}>{isSubmitting ? i18n.t("billingPurchases.submitting") : i18n.t("billingPurchases.requestRefund")}</button>
    </div> : null}
    {outcomes.length > 0 ? <div role="status" aria-live="polite"><h2>{i18n.t("billingPurchases.results")}</h2>{outcomes.map((outcome) => <p key={outcome.purchaseId}><strong>{purchases.find((purchase) => purchase.id === outcome.purchaseId)?.planName ?? i18n.t("billingPurchases.purchaseLabel")}</strong>: {outcomeText(i18n, outcome)}</p>)}</div> : null}
    {visible.length === 0 ? <p>{i18n.t("billingPurchases.empty")}</p> : <div role="list">
      {visible.map((purchase) => {
        const isEligible = eligible(purchase);
        const refund = purchase.latestRefund;
        const canReactivate = purchase.status === "WITHDRAWN" && refund?.status === "REQUESTED";
        const providerActionStarted = purchase.status === "WITHDRAWN" && refund && refund.status !== "REQUESTED";
        return <article key={purchase.id} role="listitem">
          {filter === "ALL" && purchase.status === "REQUESTED" ? <span>{i18n.t("billingPurchases.awaitingConfirmation")}</span> : null}
          {isEligible ? <input aria-label={i18n.t("billingPurchases.selectPurchase", { plan: purchase.planName })} type="checkbox" checked={selected.includes(purchase.id)} onChange={() => toggle(purchase.id)} disabled={isSubmitting} /> : null}
          <h2>{purchase.planName}</h2>
          <p>{i18n.t(`billingPurchases.status.${statusKeys[purchase.status]}`)}</p>
          <dl>
            <dt>{i18n.t("billingPurchases.purchaseDate")}</dt><dd>{i18n.formatDate(purchase.activatedAt ?? purchase.createdAt)}</dd>
            <dt>{i18n.t("billingPurchases.originalCredits")}</dt><dd>{i18n.formatNumber(purchase.creditsGranted)}</dd>
            <dt>{i18n.t("billingPurchases.currentCredits")}</dt><dd>{i18n.formatNumber(purchase.currentAmount)}</dd>
            <dt>{i18n.t("billingPurchases.reservedCredits")}</dt><dd>{i18n.formatNumber(purchase.reservedAmount)}</dd>
            <dt>{i18n.t("billingPurchases.availableCredits")}</dt><dd>{i18n.formatNumber(purchase.availableAmount)}</dd>
            <dt>{i18n.t("billingPurchases.originalAmount")}</dt><dd>{formatMoney(purchase)}</dd>
          </dl>
          {purchase.status === "ACTIVE" && !isEligible ? <p>{i18n.t("billingPurchases.noAvailableCredits")}</p> : null}
          {purchase.status === "COMPLETED" ? <p>{i18n.t("billingPurchases.completedCopy")}</p> : null}
          {purchase.status === "REFUNDED" ? <><p>{i18n.t("billingPurchases.refundedCredits", { quantity: purchase.completedRefund?.finalCreditQuantity ?? 0 })}</p><p>{formatMoney(purchase, true)}</p>{purchase.completedRefund?.completedAt ? <p>{i18n.t("billingPurchases.refundCompleted", { date: i18n.formatDate(purchase.completedRefund.completedAt) })}</p> : null}</> : null}
          {purchase.status === "WITHDRAWN" ? <p>{i18n.t("billingPurchases.refundSummary", { current: purchase.currentAmount, reserved: purchase.reservedAmount, available: purchase.availableAmount })}</p> : null}
          {canReactivate ? <button type="button" disabled={isSubmitting} onClick={() => setDialog({ type: "reactivate", purchase })}>{i18n.t("billingPurchases.reactivate")}</button> : null}
          {providerActionStarted ? <p>{i18n.t("billingPurchases.reactivationBlocked")}</p> : null}
        </article>;
      })}
    </div>}
    <nav aria-label={i18n.t("billingPurchases.paginationLabel")}>
      <button type="button" disabled={(page?.page ?? 1) <= 1 || isSubmitting} onClick={() => setSearchParams({ filter, page: String((page?.page ?? 1) - 1) })}>{i18n.t("billingPurchases.previous")}</button>
      <span>{i18n.t("billingPurchases.page", { page: page?.page ?? 1, totalPages: Math.max(1, Math.ceil((page?.total ?? 0) / (page?.pageSize ?? 20))) })}</span>
      <button type="button" disabled={(page?.page ?? 1) >= Math.ceil((page?.total ?? 0) / (page?.pageSize ?? 20)) || isSubmitting} onClick={() => setSearchParams({ filter, page: String((page?.page ?? 1) + 1) })}>{i18n.t("billingPurchases.next")}</button>
    </nav>
    {dialog?.type === "refund" ? <dialog open aria-modal="true" aria-labelledby="refund-confirm-title"><h2 id="refund-confirm-title">{i18n.t("billingPurchases.confirmRefundTitle")}</h2><ul>{selectedPurchases.map((purchase) => <li key={purchase.id}>{purchase.planName}</li>)}</ul><p>{i18n.t("billingPurchases.confirmUnused")}</p><p>{i18n.t("billingPurchases.confirmInProgress")}</p><p>{i18n.t("billingPurchases.confirmDifference")}</p><p>{i18n.t("billingPurchases.confirmNoNewConversation")}</p><p>{i18n.t("billingPurchases.confirmIndependent")}</p><button type="button" onClick={() => setDialog(null)}>{i18n.t("billingPurchases.cancel")}</button><button autoFocus type="button" onClick={requestRefund} disabled={isSubmitting}>{i18n.t("billingPurchases.confirm")}</button></dialog> : null}
    {dialog?.type === "reactivate" ? <dialog open aria-modal="true" aria-labelledby="reactivate-confirm-title"><h2 id="reactivate-confirm-title">{i18n.t("billingPurchases.confirmReactivateTitle")}</h2><p>{i18n.t("billingPurchases.confirmReactivate")}</p><button type="button" onClick={() => setDialog(null)}>{i18n.t("billingPurchases.cancel")}</button><button autoFocus type="button" onClick={() => reactivate(dialog.purchase.id)} disabled={isSubmitting}>{i18n.t("billingPurchases.confirm")}</button></dialog> : null}
  </section>;
}
