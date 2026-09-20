import type { ComponentProps } from "react";
import { Form, Link } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import type { loadOverviewPerformance } from "../../routes/app/home/overview.server";
import type { MerchantRecoveryCapacityState } from "../../services/billing/billing.types";
import { recoveryListUrl } from "../../routes/app/recoveries/recovery-list-state";
import { recoveryDetailUrl } from "../../routes/app/recovery-detail/state";
import BillingSetupStatus from "../billing-setup/BillingSetupStatus";
import LifecycleRestrictionBanner from "./LifecycleRestrictionBanner";
import MerchantPricingCatalogue from "../merchant-pricing/MerchantPricingCatalogue";
import PendingRecoveries from "./PendingRecoveries";
import "./RecoveryOverview.css";

export type OverviewProps = {
  merchantUi: { locale: string; timeZone: string; fallbackLocale?: string };
  performance: Awaited<ReturnType<typeof loadOverviewPerformance>>;
  capacity: MerchantRecoveryCapacityState | null;
  subscription: Record<string, unknown> | null;
  billingSetup?: ComponentProps<typeof BillingSetupStatus>["setup"] | null;
  merchantExperienceState: string;
  pricingCatalogue: ComponentProps<
    typeof MerchantPricingCatalogue
  >["pricingCatalogue"];
  pendingRecoveries: ComponentProps<
    typeof PendingRecoveries
  >["pendingRecoveries"];
  pendingRecoveriesUpdatedAt?: string | null;
  busy?: boolean;
  onRefresh: () => void;
};
export default function RecoveryOverview({
  merchantUi,
  performance,
  capacity,
  subscription,
  billingSetup,
  merchantExperienceState,
  pricingCatalogue,
  pendingRecoveries,
  pendingRecoveriesUpdatedAt,
  busy = false,
  onRefresh,
}: OverviewProps) {
  const i18n = createMerchantI18n(merchantUi);
  const t = i18n.t;
  const { filters, embed, overview, today, presets, state } = performance;
  const home = (from = filters.from, to = filters.to) =>
    `/app?${new URLSearchParams({ ...embed, from, to })}`;
  const money = (value: string | null, currency: string | null) => {
    if (value === null || !currency) return t("common.unavailable");
    try {
      return i18n.formatMoney(value, currency);
    } catch {
      return t("common.unavailable");
    }
  };
  const capacityKey = !capacity
    ? "common.unavailable"
    : capacity.availability === "AVAILABLE"
      ? "overview.available"
      : capacity?.availability === "EXHAUSTED"
        ? "overview.exhausted"
        : capacity?.availability === "CONTRACT_FROZEN"
          ? "billing.frozenDescription"
          : capacity?.availability === "CONTRACT_REQUIRED"
            ? "billing.contractRequiredDescription"
            : "billing.configurationUnavailableDescription";
  const summary = overview?.summary;
  return (
    <main className="recovery-overview" dir={i18n.direction}>
      <header>
        <div>
          <h1>{t("overview.title")}</h1>
          <p>{t("overview.description")}</p>
        </div>
        <button onClick={onRefresh} disabled={busy}>
          {t("pending.refresh")}
        </button>
      </header>
      {billingSetup ? (
        <BillingSetupStatus merchantUi={merchantUi} setup={billingSetup} />
      ) : (
        <LifecycleRestrictionBanner
          merchantUi={merchantUi}
          subscription={subscription}
          capacity={capacity}
        />
      )}
      <section
        className="recovery-overview__performance"
        aria-busy={busy}
        aria-label={t("overview.title")}
      >
        <nav
          className="recovery-overview__presets"
          aria-label={t("recoveries.dates")}
        >
          <Link to={home(presets.today, today)}>{t("recoveries.today")}</Link>
          <Link to={home(presets.week, today)}>{t("recoveries.week")}</Link>
          <Link to={home(presets.month, today)}>{t("recoveries.month")}</Link>
          <a href="#overview-from">{t("recoveries.custom")}</a>
        </nav>
        <Form
          method="get"
          action="/app"
          key={home()}
          className="recovery-overview__dates"
          preventScrollReset
        >
          {Object.entries(embed).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <label>
            {t("recoveries.from")}
            <input
              id="overview-from"
              type="date"
              name="from"
              defaultValue={filters.from}
              max={today}
              required
            />
          </label>
          <label>
            {t("recoveries.to")}
            <input
              type="date"
              name="to"
              defaultValue={filters.to}
              max={today}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {t("recoveries.apply")}
          </button>
        </Form>
        <p>{t("recoveries.zone", { zone: merchantUi.timeZone })}</p>
        {busy ? (
          <div role="status" className="recovery-overview__loading">
            <p>{t("recoveries.loading")}</p>
            {[0, 1, 2].map((n) => (
              <div className="recovery-overview__skeleton" key={n} />
            ))}
          </div>
        ) : state !== "ready" ? (
          <div role="alert">
            <p>
              {t(
                state === "invalid"
                  ? "recoveries.invalid.date"
                  : "recoveries.error",
              )}
            </p>
            {state === "invalid" ? (
              <Link to={home(presets.month, today)}>
                {t("recoveries.clear")}
              </Link>
            ) : (
              <button onClick={onRefresh}>{t("pending.refresh")}</button>
            )}
          </div>
        ) : summary ? (
          <>
            <dl className="recovery-overview__metrics">
              <div>
                <dt>{t("overview.started")}</dt>
                <dd>{i18n.formatNumber(summary.started)}</dd>
              </div>
              <div>
                <dt>{t("overview.recovered")}</dt>
                <dd>{i18n.formatNumber(summary.recovered)}</dd>
              </div>
              <div>
                <dt>{t("overview.rate")}</dt>
                <dd>
                  {summary.recoveryRate === null
                    ? "—"
                    : i18n.formatNumber(summary.recoveryRate, {
                        style: "percent",
                        maximumFractionDigits: 1,
                      })}
                </dd>
              </div>
              <div>
                <dt>{t("overview.value")}</dt>
                <dd>
                  {summary.recoveredValues.length
                    ? summary.recoveredValues.map((value) => (
                        <span key={value.currency}>
                          {money(value.totalPrice, value.currency)}
                        </span>
                      ))
                    : summary.unknownValueCount
                      ? t("common.unavailable")
                      : "—"}
                </dd>
                {summary.unknownValueCount > 0 && (
                  <p>
                    {t("overview.incomplete", {
                      count: summary.unknownValueCount,
                    })}
                  </p>
                )}
              </div>
              <div>
                <dt>{t("overview.ongoing")}</dt>
                <dd>
                  <Link
                    to={recoveryListUrl(
                      { ...filters, status: "ongoing" },
                      embed,
                    )}
                  >
                    {i18n.formatNumber(summary.ongoing)}
                  </Link>
                </dd>
              </div>
            </dl>
            <div className="recovery-overview__recent-heading">
              <h2>{t("overview.recent")}</h2>
              <Link to={recoveryListUrl(filters, embed)}>
                {t("overview.viewAll")}
              </Link>
            </div>
            {!overview?.preview.length ? (
              <p>{t("recoveries.empty")}</p>
            ) : (
              <ul className="recovery-overview__rows">
                {overview.preview.map((row) => (
                  <li key={row.id}>
                    <div>
                      <Link to={recoveryDetailUrl(row.id, filters, embed)}>
                        <span dir="auto">
                          {row.customer?.displayName ||
                            row.customer?.email ||
                            t("chart.guest")}
                        </span>
                      </Link>
                      <p>
                        {t("recoveries.checkout", {
                          date: i18n.formatDateTime(row.detectedAt, {
                            year: "numeric",
                          }),
                        })}
                      </p>
                    </div>
                    <span>{t(`recoveries.status.${row.status}`)}</span>
                    <strong>{money(row.totalPrice, row.currency)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </section>
      <section aria-labelledby="overview-capacity">
        <h2 id="overview-capacity">{t("overview.capacity")}</h2>
        <p>{t("overview.capacityHint")}</p>
        <p>
          {t("billing.currentPlan")}:{" "}
          {capacity?.reconciledPlanMapping?.name ||
            (typeof subscription?.planName === "string"
              ? subscription.planName
              : t("common.unavailable"))}
        </p>
        <p role="status">{t(capacityKey)}</p>
        <dl className="recovery-overview__balances">
          {capacity?.freeLifetime && (
            <div>
              <dt>
                {t("billing.lifetimeFreeAllowance", {
                  remaining: i18n.formatNumber(capacity.freeLifetime.remaining),
                  allowance: i18n.formatNumber(capacity.freeLifetime.granted),
                })}
              </dt>
              <dd>
                {t("overview.reserved", {
                  count: capacity.freeLifetime.reserved,
                })}
              </dd>
            </div>
          )}
          {capacity?.paidIncluded && (
            <div>
              <dt>
                {t("billing.paidIncludedAllowance", {
                  remaining: i18n.formatNumber(capacity.paidIncluded.remaining),
                  allowance: i18n.formatNumber(capacity.paidIncluded.granted),
                })}
              </dt>
              <dd>
                {t("overview.reserved", {
                  count: capacity.paidIncluded.reserved,
                })}
              </dd>
              <dd>
                {t("overview.periodEnd", {
                  date: i18n.formatDateTime(capacity.paidIncluded.periodEnd, {
                    year: "numeric",
                  }),
                })}
              </dd>
            </div>
          )}
          {capacity?.promotional && (
            <div>
              <dt>{t("billingCommerce.promotionalCredits")}</dt>
              <dd>{i18n.formatNumber(capacity.promotional.remaining)}</dd>
              <dd>
                {t("overview.reserved", {
                  count: capacity.promotional.reserved,
                })}
              </dd>
              <dd>{t("overview.expiryUnavailable")}</dd>
            </div>
          )}
          {capacity?.purchased && (
            <div>
              <dt>{t("billingCommerce.purchasedCredits")}</dt>
              <dd>{i18n.formatNumber(capacity.purchased.available)}</dd>
              <dd>
                {t("overview.reserved", { count: capacity.purchased.reserved })}
              </dd>
              <dd>
                {t("overview.refunding", {
                  count: capacity.purchased.refunding,
                })}
              </dd>
            </div>
          )}
        </dl>
        {!billingSetup &&
          (merchantExperienceState === "NO_CONTRACT" ? (
            <MerchantPricingCatalogue
              merchantUi={merchantUi}
              pricingCatalogue={pricingCatalogue}
              showChoosePlanAction
            />
          ) : (
            <Link to={`/app/billing/options?${new URLSearchParams(embed)}`}>
              {t("billingCommerce.actions.manageCapacity")}
            </Link>
          ))}
      </section>
      <section aria-label={t("pending.title")}>
        <p>{t("overview.pendingHint")}</p>
        <PendingRecoveries
          pendingRecoveries={pendingRecoveries}
          pendingRecoveriesUpdatedAt={pendingRecoveriesUpdatedAt}
          merchantUi={merchantUi}
          contextParams={{ ...embed, from: filters.from, to: filters.to }}
        />
      </section>
    </main>
  );
}
