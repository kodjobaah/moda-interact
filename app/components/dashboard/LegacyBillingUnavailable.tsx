import { Link } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import type { EmbedContext } from "../../routes/app/recoveries/recovery-list-state";
import "./RecoveryOverview.css";

export default function LegacyBillingUnavailable({
  merchantUi,
  embed,
}: {
  merchantUi: { locale: string; timeZone: string; fallbackLocale?: string };
  embed: EmbedContext;
}) {
  const i18n = createMerchantI18n(merchantUi);
  return (
    <main className="recovery-overview" dir={i18n.direction}>
      <h1>{i18n.t("dashboard.billingPeriod")}</h1>
      <section role="status">
        <p>{i18n.t("legacyBilling.unavailable")}</p>
        <Link to={`/app?${new URLSearchParams(embed)}`}>
          {i18n.t("overview.title")}
        </Link>
      </section>
    </main>
  );
}
