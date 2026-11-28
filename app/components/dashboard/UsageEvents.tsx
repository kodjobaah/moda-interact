import { Link, useNavigate } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import Breadcrumbs from "./Breadcrumbs";
import type { readUsageHistory } from "../../services/usage/history.server";
import type { EmbedContext } from "../../routes/app/recoveries/recovery-list-state";
import "./UsageEvents.css";
export type UsageData = {
  merchantUi: { locale: string; timeZone: string; fallbackLocale?: string };
  embed: EmbedContext;
  history: Awaited<ReturnType<typeof readUsageHistory>> | null;
  error?: string;
};
export default function UsageEvents({
  merchantUi,
  embed,
  history,
  error,
  busy = false,
  onRefresh,
}: UsageData & { busy?: boolean; onRefresh: () => void }) {
  const navigate = useNavigate();
  const i18n = createMerchantI18n(merchantUi);
  const t = i18n.t;
  const href = (changes: Record<string, string> = {}, reset = false) => {
    const params = new URLSearchParams(embed);
    if (history && !reset) {
      params.set("bill", history.usageView);
      if (history.chargeSource)
        params.set("chargeSource", history.chargeSource);
      if (history.selection.billId !== undefined)
        params.set("billId", history.selection.billId);
      // Freeze the resolved default for usage pagination even if a new period opens.
      else if (history.usagePagination.billId)
        params.set("billId", history.usagePagination.billId);
      params.set("pageSize", String(history.usagePagination.pageSize));
      if (history.periodCursor)
        params.set("periodCursor", history.periodCursor);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    }
    return `/app/usage?${params}`;
  };
  const paging = history?.usagePagination;
  const allTime = history?.usageView === "all";
  const sourceLabels = {
    ALL: "usageHistory.allSources",
    LIFETIME_FREE_CREDITS: "usageHistory.sourceFree",
    INCLUDED_PLAN_ALLOWANCE: "usageHistory.sourceIncluded",
    PURCHASED_TOP_UP: "usageHistory.sourcePurchased",
    PROMOTIONAL_CREDITS: "usageHistory.sourcePromotional",
    UNATTRIBUTED: "usageHistory.sourceUnattributed",
  } as const;
  return (
    <main className="usage-history" dir={i18n.direction} aria-busy={busy}>
      <Breadcrumbs
        items={[
          {
            label: t("billingCommerce.page.title"),
            href: `/app/billing/options?${new URLSearchParams(embed)}`,
          },
        ]}
        current={t("usageHistory.title")}
        merchantUi={merchantUi}
      />
      <header>
        <h1>{t("usageHistory.title")}</h1>
        <button onClick={onRefresh} disabled={busy}>
          {t("pending.refresh")}
        </button>
      </header>
      <nav
        className="usage-history__tabs"
        aria-label={t("dashboard.billingPeriod")}
      >
        <Link
          className={allTime ? "is-active" : undefined}
          aria-current={allTime ? "page" : undefined}
          to={href(
            { bill: "all", chargeSource: history?.chargeSource ?? "ALL" },
            true,
          )}
        >
          {t("usageHistory.allTime")}
        </Link>
        <Link
          className={history?.usageView === "current" ? "is-active" : undefined}
          aria-current={history?.usageView === "current" ? "page" : undefined}
          to={href(
            { bill: "current", chargeSource: history?.chargeSource ?? "ALL" },
            true,
          )}
        >
          {t("usage.current")}
        </Link>
        <Link
          className={history?.usageView === "past" ? "is-active" : undefined}
          aria-current={history?.usageView === "past" ? "page" : undefined}
          to={href(
            { bill: "past", chargeSource: history?.chargeSource ?? "ALL" },
            true,
          )}
        >
          {t("usage.past")}
        </Link>
      </nav>
      {busy ? (
        <div role="status">
          <p>{t("recoveries.loading")}</p>
          {[0, 1, 2].map((n) => (
            <div key={n} className="usage-history__skeleton" />
          ))}
        </div>
      ) : !history ? (
        <section role="alert">
          <p>
            {t(
              error === "cursor"
                ? "usageHistory.invalidCursor"
                : "usageHistory.error",
            )}
          </p>
          {error === "cursor" ? (
            <Link to={href({}, true)}>{t("recoveries.clear")}</Link>
          ) : (
            <button onClick={onRefresh}>{t("pending.refresh")}</button>
          )}
        </section>
      ) : (
        <>
          {!allTime && (
            <details className="usage-history__periods">
              <summary>{t("usageHistory.periods")}</summary>
              <ul>
                {history.periodPage.items.map((period) => (
                  <li key={period.id}>
                    <Link
                      aria-current={
                        period.id === paging?.billId ? "true" : undefined
                      }
                      to={href({ billId: period.id, page: "1" })}
                    >
                      {i18n.formatDate(period.periodStart)} —{" "}
                      {i18n.formatDate(period.periodEnd)}
                    </Link>
                  </li>
                ))}
              </ul>
              <nav aria-label={t("usageHistory.periods")}>
                {history.periodPage.previousCursor ? (
                  <Link
                    to={href({
                      periodCursor: history.periodPage.previousCursor,
                    })}
                  >
                    {t("usage.previous")}
                  </Link>
                ) : (
                  <span aria-disabled="true">{t("usage.previous")}</span>
                )}
                {history.periodPage.nextCursor ? (
                  <Link
                    to={href({ periodCursor: history.periodPage.nextCursor })}
                  >
                    {t("usage.next")}
                  </Link>
                ) : (
                  <span aria-disabled="true">{t("usage.next")}</span>
                )}
              </nav>
            </details>
          )}
          <label>
            {t("usageHistory.chargedAgainst")}{" "}
            <select
              value={history.chargeSource ?? "ALL"}
              onChange={(event) =>
                navigate(href({ chargeSource: event.target.value, page: "1" }))
              }
            >
              {Object.entries(sourceLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {t(label)}
                </option>
              ))}
            </select>
          </label>
          {history.state === "unavailable" ? (
            <p role="status">{t("legacyBilling.unavailable")}</p>
          ) : !paging || (!allTime && !paging.billId) ? (
            <p role="status">{t("usageHistory.empty")}</p>
          ) : (
            <section aria-labelledby="usage-period">
              <h2 id="usage-period">
                {allTime ? (
                  t("usageHistory.allTime")
                ) : (
                  <>
                    {i18n.formatDate(paging.periodStart)} —{" "}
                    {i18n.formatDate(paging.periodEnd)}
                  </>
                )}
              </h2>
              <p>
                {t("usage.recorded", {
                  quantity: paging.totalQuantity,
                  total: paging.total,
                })}
              </p>
              <label>
                {t("usage.rowsPerPage")}{" "}
                <select
                  value={paging.pageSize}
                  onChange={(event) => {
                    /* native links below preserve all validated context */ navigate(
                      href({ page: "1", pageSize: event.target.value }),
                    );
                  }}
                >
                  {[10, 25, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {i18n.formatNumber(size)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="usage-history__table">
                <table>
                  <thead>
                    <tr>
                      {[
                        "action",
                        "recovery",
                        "customer",
                        "chargedAgainst",
                        "quantity",
                        "recordedAt",
                      ].map((key) => (
                        <th scope="col" key={key}>
                          {t(
                            key === "chargedAgainst"
                              ? "usageHistory.chargedAgainst"
                              : `usage.${key}`,
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.usageEvents.map((event) => (
                      <tr key={event.id}>
                        <td>
                          {t(
                            event.metric === "RECOVERY_CONVERSATION"
                              ? "chart.metricCheckoutRecovery"
                              : "common.unavailable",
                          )}
                        </td>
                        <td>
                          {event.sourceRecovery ? (
                            <Link
                              to={`/app/recoveries/${encodeURIComponent(event.sourceRecovery.recoveryId)}?${new URLSearchParams(embed)}`}
                            >
                              {t("recoveries.checkout", {
                                date: i18n.formatDateTime(
                                  event.sourceRecovery.detectedAt,
                                  { year: "numeric" },
                                ),
                              })}
                            </Link>
                          ) : (
                            t("usage.unlinked")
                          )}
                        </td>
                        <td dir="auto">
                          {event.sourceRecovery
                            ? event.sourceRecovery.customerName ||
                              t("chart.guest")
                            : t("usage.unlinked")}
                        </td>
                        <td>
                          {t(
                            event.chargedAgainst
                              ? sourceLabels[event.chargedAgainst]
                              : "common.unavailable",
                          )}
                        </td>
                        <td>{i18n.formatNumber(event.quantity)}</td>
                        <td>
                          {i18n.formatDateTime(event.occurredAt, {
                            year: "numeric",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!history.usageEvents.length && <p>{t("usage.noRecorded")}</p>}
              <nav aria-label={t("usageHistory.events")}>
                <span>
                  {t("usage.range", {
                    first: i18n.formatNumber(
                      history.usageEvents.length
                        ? (paging.page - 1) * paging.pageSize + 1
                        : 0,
                    ),
                    last: i18n.formatNumber(
                      history.usageEvents.length
                        ? (paging.page - 1) * paging.pageSize +
                            history.usageEvents.length
                        : 0,
                    ),
                    total: i18n.formatNumber(paging.total),
                  })}
                </span>
                {paging.page > 1 ? (
                  <Link to={href({ page: String(paging.page - 1) })}>
                    {t("usage.previous")}
                  </Link>
                ) : (
                  <span aria-disabled="true">{t("usage.previous")}</span>
                )}
                {paging.page * paging.pageSize < paging.total ? (
                  <Link to={href({ page: String(paging.page + 1) })}>
                    {t("usage.next")}
                  </Link>
                ) : (
                  <span aria-disabled="true">{t("usage.next")}</span>
                )}
              </nav>
            </section>
          )}
        </>
      )}
    </main>
  );
}
