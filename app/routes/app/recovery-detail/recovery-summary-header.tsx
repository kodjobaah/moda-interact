import type { Detail } from "./state";
import type { Money, Stamp, Translate } from "./recovery-ui-types";

/** Display the customer name, not the Shopify domain embedded in some imported fixture names. */
export function customerHeading(customer: Detail["customer"], fallback: string) {
  const fullName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim();
  const shopDomain = fullName.match(/--([a-z0-9-]+\.myshopify\.com)\b/iu)?.[1] ?? null;
  const name = fullName.replace(/--[a-z0-9-]+\.myshopify\.com\b/giu, "").replace(/\s+/gu, " ").trim();
  return { name: name || customer?.email || fallback, shopDomain };
}

export function RecoverySummaryHeader({ detail, t, money, stamp, status }: {
  detail: Detail;
  t: Translate;
  money: Money;
  stamp: Stamp;
  status: (value: string | null) => string;
}) {
  const { name, shopDomain } = customerHeading(detail.customer, t("chart.guest"));
  const email = detail.customer?.email;
  return (
    <header className="recovery-detail__header">
      <div className="recovery-detail__identity">
        <p className="recovery-detail__eyebrow">{t("chart.recoveryDetails")}</p>
        <h1 dir="auto">{name}</h1>
        {email && email !== name ? <p dir="auto" className="recovery-detail__identity-meta">{email}</p> : null}
        {shopDomain ? <p className="recovery-detail__identity-meta">{shopDomain}</p> : null}
      </div>
      <dl className="recovery-detail__summary">
        <div><dt>{t("recoveries.value")}</dt><dd>{money(detail.value)}</dd></div>
        <div><dt>{t("pending.status")}</dt><dd>{status(detail.status)}</dd></div>
        <div><dt>{t("recoveries.started")}</dt><dd>{stamp(detail.milestones.detectedAt)}</dd></div>
      </dl>
    </header>
  );
}
