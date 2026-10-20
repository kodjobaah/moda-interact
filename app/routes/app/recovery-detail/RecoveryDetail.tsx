import { Link } from "react-router";
import { createMerchantI18n } from "../../../utils/merchant-i18n";
import { recoveryListUrl } from "../recoveries/recovery-list-state";
import type { DetailData } from "./state";
import { RecoverySummaryHeader } from "./recovery-summary-header";
import { RecoveryConversationThread } from "./recovery-conversation-thread";
import { RecoverySidebar } from "./recovery-sidebar";
import "./RecoveryDetail.css";
import "./recovery-conversation.css";
import "./recovery-sidebar.css";

// Keep the historically imported safe renderer available to existing consumers/tests.
export { MessageText } from "./recovery-message-list";

/** Layout coordinator only: read models, command controllers and reusable UI live in separate modules. */
export default function RecoveryDetail({ data, busy = false, onRefresh }: {
  data: DetailData;
  busy?: boolean;
  onRefresh: () => void;
}) {
  const i18n = createMerchantI18n(data.merchantUi);
  const t = i18n.t;
  const { detail, filters, embed } = data;
  const money = (value: { amount: string | null; currency: string | null }) => {
    if (value.amount === null || !value.currency) return t("common.unavailable");
    try { return i18n.formatMoney(value.amount, value.currency); }
    catch { return t("common.unavailable"); }
  };
  const stamp = (value: string) => (
    <time dateTime={value}>{i18n.formatDateTime(value, { year: "numeric" })}</time>
  );
  const status = (value: string | null) => value ? t(`recoveries.status.${value}`) : t("common.unavailable");
  const listUrl = recoveryListUrl(filters, embed);
  return (
    <main className="recovery-detail" aria-busy={busy}>
      <Link className="recovery-detail__back" to={listUrl} state={{ recoveryListScrollKey: listUrl }}>
        {t("recoveryDetail.back")}
      </Link>
      {data.state !== "ready" || !detail ? (
        <section className="recovery-detail__card">
          <h1>{t(data.state === "error" ? "recoveryDetail.sectionError" : "recoveryDetail.unavailable")}</h1>
          {data.state === "error" ? (
            <button type="button" disabled={busy} onClick={onRefresh}>{t("pending.refresh")}</button>
          ) : null}
        </section>
      ) : (
        <>
          <RecoverySummaryHeader detail={detail} t={t} money={money} stamp={stamp} status={status} />
          <div className="recovery-detail__layout">
            <RecoveryConversationThread detail={detail} data={data} t={t} i18n={i18n} stamp={stamp} onRefresh={onRefresh} />
            <RecoverySidebar detail={detail} data={data} t={t} i18n={i18n} money={money} stamp={stamp} status={status} />
          </div>
        </>
      )}
    </main>
  );
}
