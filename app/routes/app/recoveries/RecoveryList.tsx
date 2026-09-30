import { Form, Link } from "react-router";
import { createMerchantI18n } from "../../../utils/merchant-i18n";
import {
  listStatuses,
  recoveryListUrl,
  type RecoveryListData,
} from "./recovery-list-state";
import "./RecoveryList.css";
import { recoveryDetailUrl } from "../recovery-detail/state";

export default function RecoveryList({
  data,
  busy = false,
  onRefresh,
}: {
  data: RecoveryListData;
  busy?: boolean;
  onRefresh: () => void;
}) {
  const i18n = createMerchantI18n(data.merchantUi);
  const t = i18n.t;
  const { filters, embed, page } = data;
  const clear = recoveryListUrl(
    {
      ...filters,
      from: data.presets.month,
      to: data.today,
      q: "",
      status: "all",
      pageSize: 25,
      cursor: null,
    },
    embed,
  );
  const preset = (from: string) =>
    recoveryListUrl({ ...filters, from, to: data.today, cursor: null }, embed);
  const money = (value: string | null, currency: string | null) => {
    if (value === null || !currency?.trim()) return t("common.unavailable");
    try {
      return i18n.formatMoney(value, currency);
    } catch {
      return t("common.unavailable");
    }
  };
  const calendarLabel = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
      ? i18n.formatDate(`${value}T12:00:00Z`, { timeZone: "UTC" })
      : value;
  return (
    <main
      className="recovery-list"
      aria-labelledby="recoveries-title"
      aria-busy={busy}
    >
      <header className="recovery-list__header">
        <div>
          <h1 id="recoveries-title">{t("recoveries.title")}</h1>
          <p>{t("recoveries.description")}</p>
        </div>
        <button
          type="button"
          className="recovery-list__button"
          onClick={onRefresh}
          disabled={busy}
        >
          {t("pending.refresh")}
        </button>
      </header>
      <section
        className="recovery-list__filters"
        aria-label={t("recoveries.filters")}
      >
        <nav
          className="recovery-list__presets"
          aria-label={t("recoveries.dates")}
        >
          <Link to={preset(data.presets.today)}>{t("recoveries.today")}</Link>
          <Link to={preset(data.presets.week)}>{t("recoveries.week")}</Link>
          <Link to={preset(data.presets.month)}>{t("recoveries.month")}</Link>
          <a href="#recovery-from">{t("recoveries.custom")}</a>
        </nav>
        <Form
          method="get"
          action="/app/recoveries"
          key={recoveryListUrl(filters, embed)}
          className="recovery-list__form"
          preventScrollReset
        >
          {Object.entries(embed).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <input type="hidden" name="pageSize" value={filters.pageSize} />
          <label htmlFor="recovery-from">
            {t("recoveries.from")}
            <input
              id="recovery-from"
              name="from"
              type="date"
              defaultValue={filters.from}
              max={data.today}
              required
            />
          </label>
          <label htmlFor="recovery-to">
            {t("recoveries.to")}
            <input
              id="recovery-to"
              name="to"
              type="date"
              defaultValue={filters.to}
              max={data.today}
              required
            />
          </label>
          <label htmlFor="recovery-search" className="recovery-list__search">
            {t("recoveries.search")}
            <input
              id="recovery-search"
              name="q"
              type="search"
              defaultValue={filters.q}
              maxLength={100}
            />
          </label>
          <label htmlFor="recovery-status">
            {t("pending.status")}
            <select
              id="recovery-status"
              name="status"
              defaultValue={filters.status}
            >
              {listStatuses.map((status) => (
                <option key={status} value={status}>
                  {t(`recoveries.status.${status}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="recovery-list__button recovery-list__button--primary"
            type="submit"
            disabled={busy}
          >
            {t("recoveries.apply")}
          </button>
        </Form>
        <div className="recovery-list__filter-footer">
          <p>{t("recoveries.zone", { zone: data.merchantUi.timeZone })}</p>
          <Link to={clear}>{t("recoveries.clear")}</Link>
        </div>
      </section>
      <section
        className="recovery-list__results"
        aria-labelledby="recoveries-results"
      >
        <div className="recovery-list__results-heading">
          <h2 id="recoveries-results">{t("recoveries.title")}</h2>
          <p>
            {calendarLabel(filters.from)} — {calendarLabel(filters.to)}
          </p>
        </div>
        {busy ? (
          <div role="status" className="recovery-list__loading">
            <span>{t("recoveries.loading")}</span>
            {[0, 1, 2].map((n) => (
              <div
                className="recovery-list__skeleton"
                key={n}
                aria-hidden="true"
              />
            ))}
          </div>
        ) : (
          <>
            {data.state === "invalid" ? (
              <div role="alert" className="recovery-list__notice">
                <h3>{t(`recoveries.invalid.${data.error}`)}</h3>
                <Link to={clear}>{t("recoveries.clear")}</Link>
              </div>
            ) : null}
            {data.state === "error" ? (
              <div role="alert" className="recovery-list__notice">
                <h3>{t("recoveries.error")}</h3>
                <button
                  type="button"
                  className="recovery-list__button"
                  onClick={onRefresh}
                >
                  {t("pending.refresh")}
                </button>
              </div>
            ) : null}
            {data.state === "never-used" || data.state === "empty" ? (
              <div role="status" className="recovery-list__notice">
                <h3>
                  {t(
                    data.state === "never-used"
                      ? "recoveries.never"
                      : "recoveries.empty",
                  )}
                </h3>
                <p>
                  {t(
                    data.state === "never-used"
                      ? "recoveries.neverHint"
                      : "recoveries.emptyHint",
                  )}
                </p>
                {data.state === "empty" ? (
                  <Link to={clear}>{t("recoveries.clear")}</Link>
                ) : null}
              </div>
            ) : null}
            {data.state === "ready" ? (
              <ul className="recovery-list__rows">
                {page.items.map((row) => (
                  <li className="recovery-list__row" key={row.id}>
                    <div className="recovery-list__customer">
                      <h3 dir="auto">
                        <Link to={recoveryDetailUrl(row.id, filters, embed)}>
                          {row.customer?.displayName ||
                            row.customer?.email ||
                            t("chart.guest")}
                        </Link>
                      </h3>
                      {row.customer?.displayName && row.customer.email ? (
                        <p dir="auto">{row.customer.email}</p>
                      ) : null}
                      <p>
                        {t("recoveries.checkout", {
                          date: i18n.formatDateTime(row.detectedAt, {
                            year: "numeric",
                          }),
                        })}
                      </p>
                    </div>
                    <dl>
                      <div>
                        <dt>{t("pending.status")}</dt>
                        <dd>
                          <span
                            className={`recovery-list__status recovery-list__status--${row.status}`}
                          >
                            {t(`recoveries.status.${row.status}`)}
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>{t("recoveries.value")}</dt>
                        <dd>{money(row.totalPrice, row.currency)}</dd>
                      </div>
                      <div>
                        <dt>{t("recoveries.started")}</dt>
                        <dd>
                          <time dateTime={row.detectedAt}>
                            {i18n.formatDateTime(row.detectedAt, {
                              year: "numeric",
                            })}
                          </time>
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        <nav
          className="recovery-list__pagination"
          aria-label={t("recoveries.pages")}
        >
          {page.previousCursor && !busy ? (
            <Link to={recoveryListUrl(filters, embed, page.previousCursor)}>
              {t("usage.previous")}
            </Link>
          ) : (
            <span aria-disabled="true">{t("usage.previous")}</span>
          )}
          {page.nextCursor && !busy ? (
            <Link to={recoveryListUrl(filters, embed, page.nextCursor)}>
              {t("usage.next")}
            </Link>
          ) : (
            <span aria-disabled="true">{t("usage.next")}</span>
          )}
        </nav>
      </section>
    </main>
  );
}
