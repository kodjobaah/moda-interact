// @ts-nocheck
/* eslint-disable react/prop-types */
/* eslint-disable jsx-a11y/no-autofocus */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useRevalidator, useSearchParams } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import "./BillingPurchaseHub.css";

const FILTERS = ["ACTIVE", "WITHDRAWN", "COMPLETED", "REFUNDED", "ALL"];
const PAGE_SIZES = [5, 10, 20];
const statusKeys = {
  REQUESTED: "requested",
  ACTIVE: "active",
  WITHDRAWN: "withdrawn",
  COMPLETED: "completed",
  REFUNDED: "refunded",
};


function packLabel(eventHandle) {
  if (typeof eventHandle !== "string" || !eventHandle.trim()) return "";
  return eventHandle
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function eligible(purchase) {
  return (
    purchase.status === "ACTIVE" &&
    purchase.availableAmount > 0 &&
    purchase.refundEligible !== false
  );
}

function outcomeText(i18n, outcome) {
  const values = {
    current: i18n.formatNumber(outcome.currentAmount ?? 0),
    reserved: i18n.formatNumber(outcome.reservedAmount ?? 0),
    available: i18n.formatNumber(outcome.availableAmount ?? 0),
  };
  return i18n.t(`billingPurchases.outcome.${outcome.code}`, values);
}

export default function RecoveryCreditPurchaseManager({
  merchantUi,
  page,
  filter,
}) {
  const i18n = createMerchantI18n(merchantUi);
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState([]);
  const [dialog, setDialog] = useState(null);
  const submissionLock = useRef(false);
  const purchases = useMemo(() => page?.purchases ?? [], [page]);
  const visible = purchases;
  const eligibleVisible = useMemo(() => visible.filter(eligible), [visible]);
  const selectedPurchases = purchases.filter(
    (purchase) => selected.includes(purchase.id) && eligible(purchase),
  );
  const isSubmitting = fetcher.state !== "idle";
  const outcomes = Array.isArray(fetcher.data) ? fetcher.data : [];
  const currentPage = page?.page ?? 1;
  const currentPageSize = page?.pageSize ?? 5;
  const totalPurchases = page?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalPurchases / currentPageSize));
  const firstItem =
    totalPurchases === 0 ? 0 : (currentPage - 1) * currentPageSize + 1;
  const lastItem = Math.min(currentPage * currentPageSize, totalPurchases);

  const updatePagination = (nextPage, nextPageSize = currentPageSize) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("filter", filter);
    nextParams.set("page", String(nextPage));
    nextParams.set("pageSize", String(nextPageSize));
    setSearchParams(nextParams, { preventScrollReset: true });
  };

  useEffect(() => {
    setSelected((ids) =>
      ids.filter((id) =>
        eligibleVisible.some((purchase) => purchase.id === id),
      ),
    );
  }, [eligibleVisible, filter]);

  useEffect(() => {
    if (fetcher.state === "idle") submissionLock.current = false;
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      (Array.isArray(fetcher.data) || fetcher.data.code)
    ) {
      revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, revalidator]);

  const setFilter = (nextFilter) => {
    setSelected([]);
    setSearchParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        nextParams.set("filter", nextFilter);
        nextParams.set("page", "1");
        nextParams.set("pageSize", String(currentPageSize));
        return nextParams;
      },
      { preventScrollReset: true },
    );
  };

  const toggle = (purchaseId) => {
    setSelected((ids) =>
      ids.includes(purchaseId)
        ? ids.filter((id) => id !== purchaseId)
        : [...ids, purchaseId],
    );
  };

  const toggleAll = () => {
    const ids = eligibleVisible.map((purchase) => purchase.id);
    setSelected((current) =>
      ids.every((id) => current.includes(id))
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])],
    );
  };

  const requestRefund = () => {
    if (selectedPurchases.length === 0 || submissionLock.current) return;
    submissionLock.current = true;
    setDialog(null);
    const form = new FormData();
    form.set("intent", "request_refund");
    form.set("requestId", crypto.randomUUID());
    selectedPurchases.forEach((purchase) =>
      form.append("purchaseId", purchase.id),
    );
    fetcher.submit(form, { method: "post" });
    setSelected([]);
  };

  const reactivate = (purchaseId) => {
    setDialog(null);
    fetcher.submit({ intent: "reactivate", purchaseId }, { method: "post" });
  };

  const formatMoney = (purchase) => {
    const money = purchase.originalProviderPurchase;
    if (!money) return i18n.t("billingPurchases.notAvailable");
    return i18n.formatMoney(money.amount, money.currency);
  };

  return (
    <section className="moda-billing-panel moda-purchase-history" aria-labelledby="purchase-manager-title">
      <div className="moda-panel-heading-row moda-purchase-history-heading">
        <div>
          <div className="moda-eyebrow">
            {i18n.t("billingPurchases.eyebrow")}
          </div>
          <h1 id="purchase-manager-title">
            {i18n.t("billingPurchases.title")}
          </h1>
          <p>{i18n.t("billingPurchases.description")}</p>
        </div>
      </div>
      <div className="moda-purchase-filter-tabs" role="tablist" aria-label={i18n.t("billingPurchases.filtersLabel")}>
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? "is-active" : ""}
            onClick={() => setFilter(value)}
          >
            {i18n.t(`billingPurchases.filter.${value}`)}
          </button>
        ))}
      </div>
      {eligibleVisible.length > 0 ? (
        <div className="moda-purchase-toolbar">
          <label className="moda-purchase-select-all">
            <input
              type="checkbox"
              checked={eligibleVisible.every((purchase) =>
                selected.includes(purchase.id),
              )}
              onChange={toggleAll}
              disabled={isSubmitting}
            />
            <span>{i18n.t("billingPurchases.selectAll")}</span>
          </label>
          <button
            className="moda-action-button moda-action-button-primary"
            type="button"
            disabled={selectedPurchases.length === 0 || isSubmitting}
            onClick={() => setDialog({ type: "refund" })}
          >
            {isSubmitting
              ? i18n.t("billingPurchases.submitting")
              : i18n.t("billingPurchases.requestRefund")}
          </button>
        </div>
      ) : null}
      {outcomes.length > 0 ? (
        <div className="moda-purchase-results" role="status" aria-live="polite">
          <h2>{i18n.t("billingPurchases.results")}</h2>
          {outcomes.map((outcome) => (
            <p key={outcome.purchaseId}>
              <strong>
                {(() => {
                  const purchase = purchases.find((entry) => entry.id === outcome.purchaseId);
                  return purchase ? packLabel(purchase.eventHandle) : i18n.t("billingPurchases.purchaseLabel");
                })()}
              </strong>
              : {outcomeText(i18n, outcome)}
            </p>
          ))}
        </div>
      ) : null}
      {visible.length === 0 ? (
        <div className="moda-empty-state">{i18n.t("billingPurchases.empty")}</div>
      ) : (
        <div className="moda-purchase-list" role="list">
          {visible.map((purchase) => {
            const isEligible = eligible(purchase);
            const refund = purchase.latestRefund;
            const canReactivate =
              purchase.status === "WITHDRAWN" && refund?.status === "REQUESTED";
            const providerActionStarted =
              purchase.status === "WITHDRAWN" &&
              refund &&
              refund.status !== "REQUESTED";
            return (
              <article className={`moda-purchase-card ${selected.includes(purchase.id) ? "is-selected" : ""}`} key={purchase.id} role="listitem">
                <div className="moda-purchase-card-header">
                  <div>
                    <div className="moda-purchase-card-title-row">
                      <h2>{packLabel(purchase.eventHandle)}</h2>
                      <span className={`moda-purchase-status moda-purchase-status-${purchase.status.toLowerCase()}`}>
                        {i18n.t(
                          `billingPurchases.status.${statusKeys[purchase.status]}`,
                        )}
                      </span>
                    </div>
                    <p className="moda-purchase-plan">{purchase.planName}</p>
                  </div>
                  {isEligible ? (
                    <label className="moda-purchase-card-select">
                      <input
                        aria-label={i18n.t("billingPurchases.selectPurchase", {
                          plan: packLabel(purchase.eventHandle),
                        })}
                        type="checkbox"
                        checked={selected.includes(purchase.id)}
                        onChange={() => toggle(purchase.id)}
                        disabled={isSubmitting}
                      />
                    </label>
                  ) : null}
                </div>
                {filter === "ALL" && purchase.status === "REQUESTED" ? (
                  <div className="moda-purchase-notice">{i18n.t("billingPurchases.awaitingConfirmation")}</div>
                ) : null}
                <dl className="moda-purchase-metrics">
                  <dt>{i18n.t("billingPurchases.purchaseDate")}</dt>
                  <dd>
                    {i18n.formatDate(
                      purchase.activatedAt ?? purchase.createdAt,
                    )}
                  </dd>
                  <dt>{i18n.t("billingPurchases.originalCredits")}</dt>
                  <dd>{i18n.formatNumber(purchase.creditsGranted)}</dd>
                  <dt>{i18n.t("billingPurchases.currentCredits")}</dt>
                  <dd>{i18n.formatNumber(purchase.currentAmount)}</dd>
                  <dt>{i18n.t("billingPurchases.reservedCredits")}</dt>
                  <dd>{i18n.formatNumber(purchase.reservedAmount)}</dd>
                  <dt>{i18n.t("billingPurchases.availableCredits")}</dt>
                  <dd>{i18n.formatNumber(purchase.availableAmount)}</dd>
                  <dt>{i18n.t("billingPurchases.originalAmount")}</dt>
                  <dd>{formatMoney(purchase)}</dd>
                </dl>
                {purchase.status === "ACTIVE" && !isEligible ? (
                  <p>
                    {purchase.refundEligible === false &&
                    purchase.availableAmount > 0
                      ? purchase.refundUnavailableReason === "ZERO_VALUE"
                        ? i18n.t("billingPurchases.zeroValueNotRefundable")
                        : i18n.t("billingPurchases.historicalNotRefundable")
                      : i18n.t("billingPurchases.noAvailableCredits")}
                  </p>
                ) : null}
                {purchase.status === "COMPLETED" ? (
                  <p>{i18n.t("billingPurchases.completedCopy")}</p>
                ) : null}
                {purchase.status === "REFUNDED" ? (
                  <React.Fragment>
                    <p>
                      {i18n.t("billingPurchases.refundedCredits", {
                        quantity: i18n.formatNumber(
                          purchase.completedRefund?.finalCreditQuantity ?? 0,
                        ),
                      })}
                    </p>
                    {purchase.completedRefund?.completedAt ? (
                      <p>
                        {i18n.t("billingPurchases.refundCompleted", {
                          date: i18n.formatDate(
                            purchase.completedRefund.completedAt,
                          ),
                        })}
                      </p>
                    ) : null}
                  </React.Fragment>
                ) : null}
                {purchase.status === "WITHDRAWN" ? (
                  <p>
                    {i18n.t("billingPurchases.refundSummary", {
                      current: i18n.formatNumber(purchase.currentAmount),
                      reserved: i18n.formatNumber(purchase.reservedAmount),
                      available: i18n.formatNumber(
                        purchase.heldForRefundAmount,
                      ),
                    })}
                  </p>
                ) : null}
                {isEligible ? (
                  <div className="moda-purchase-card-actions">
                    <button
                      className="moda-action-button moda-action-button-primary"
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        setSelected([purchase.id]);
                        setDialog({ type: "refund" });
                      }}
                    >
                      {i18n.t("billingPurchases.requestRefund")}
                    </button>
                  </div>
                ) : null}
                {canReactivate ? (
                  <button
                    className="moda-action-button moda-action-button-secondary"
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => setDialog({ type: "reactivate", purchase })}
                  >
                    {i18n.t("billingPurchases.reactivate")}
                  </button>
                ) : null}
                {providerActionStarted ? (
                  <p>{i18n.t("billingPurchases.reactivationBlocked")}</p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      <div className="moda-purchase-pagination-shell">
        <label className="moda-purchase-page-size">
          <select
            aria-label={i18n.t("billingPurchases.paginationLabel")}
            value={currentPageSize}
            disabled={isSubmitting}
            onChange={(event) =>
              updatePagination(1, Number(event.target.value))
            }
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {i18n.t("usage.perPage", {
                  size: i18n.formatNumber(size),
                })}
              </option>
            ))}
          </select>
        </label>
        <nav
          className="moda-purchase-pagination"
          aria-label={i18n.t("billingPurchases.paginationLabel")}
        >
          <span className="moda-purchase-range">
            {i18n.t("usage.range", {
              first: i18n.formatNumber(firstItem),
              last: i18n.formatNumber(lastItem),
              total: i18n.formatNumber(totalPurchases),
            })}
          </span>
          <button
            className="moda-action-button moda-action-button-secondary"
            type="button"
            disabled={currentPage <= 1 || isSubmitting}
            onClick={() => updatePagination(currentPage - 1)}
          >
            {i18n.t("billingPurchases.previous")}
          </button>
          <span>
            {i18n.t("billingPurchases.page", {
              page: currentPage,
              totalPages,
            })}
          </span>
          <button
            className="moda-action-button moda-action-button-secondary"
            type="button"
            disabled={currentPage >= totalPages || isSubmitting}
            onClick={() => updatePagination(currentPage + 1)}
          >
            {i18n.t("billingPurchases.next")}
          </button>
        </nav>
      </div>
      {dialog?.type === "refund" ? (
        <dialog className="moda-purchase-dialog" open aria-modal="true" aria-labelledby="refund-confirm-title">
          <h2 id="refund-confirm-title">
            {i18n.t("billingPurchases.confirmRefundTitle")}
          </h2>
          <ul>
            {selectedPurchases.map((purchase) => (
              <li key={purchase.id}>{packLabel(purchase.eventHandle)}</li>
            ))}
          </ul>
          <p>{i18n.t("billingPurchases.confirmUnused")}</p>
          <p>{i18n.t("billingPurchases.confirmInProgress")}</p>
          <p>{i18n.t("billingPurchases.confirmDifference")}</p>
          <p>{i18n.t("billingPurchases.confirmNoNewConversation")}</p>
          <p>{i18n.t("billingPurchases.confirmIndependent")}</p>
          <div className="moda-purchase-dialog-actions">
            <button className="moda-action-button moda-action-button-secondary" type="button" onClick={() => setDialog(null)}>
              {i18n.t("billingPurchases.cancel")}
            </button>
            <button
              className="moda-action-button moda-action-button-primary"
              autoFocus
              type="button"
              onClick={requestRefund}
              disabled={isSubmitting || submissionLock.current}
            >
              {isSubmitting
                ? i18n.t("billingPurchases.submitting")
                : i18n.t("billingPurchases.confirm")}
            </button>
          </div>
        </dialog>
      ) : null}
      {dialog?.type === "reactivate" ? (
        <dialog
          className="moda-purchase-dialog"
          open
          aria-modal="true"
          aria-labelledby="reactivate-confirm-title"
        >
          <h2 id="reactivate-confirm-title">
            {i18n.t("billingPurchases.confirmReactivateTitle")}
          </h2>
          <p>{i18n.t("billingPurchases.confirmReactivate")}</p>
          <div className="moda-purchase-dialog-actions">
            <button className="moda-action-button moda-action-button-secondary" type="button" onClick={() => setDialog(null)}>
              {i18n.t("billingPurchases.cancel")}
            </button>
            <button
              className="moda-action-button moda-action-button-primary"
              autoFocus
            type="button"
            onClick={() => reactivate(dialog.purchase.id)}
            disabled={isSubmitting}
          >
              {i18n.t("billingPurchases.confirm")}
            </button>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
