import type { ReactNode } from "react";
import type { Detail } from "./state";
import type { createMerchantI18n } from "../../../utils/merchant-i18n";

type Translate = ReturnType<typeof createMerchantI18n>["t"];

/** Informational state only: command acceptance rechecks actual eligibility in PostgreSQL. */
export function followUpDisplayState(detail: Detail): "used" | "eligible" | "unavailable" {
  const conversation = detail.conversation;
  if (conversation?.followUp.used) return "used";
  if (!conversation || ["COMPLETED", "EXPIRED", "CANCELLED"].includes(detail.status ?? "") ||
    conversation.humanMessagingStatus === "SUSPENDED" || !conversation.followUp.eligible ||
    !conversation.followUp.hasApprovedTemplate) return "unavailable";
  return "eligible";
}

export function RecoveryOutreachStatus({ detail, t, stamp, status }: {
  detail: Detail;
  t: Translate;
  stamp: (value: string) => ReactNode;
  status: (value: string | null) => string;
}) {
  const initial = detail.initialOutreachSentAt ?? detail.milestones.messageSentAt;
  const followUpKey = {
    used: "recoveryDetail.followUpAlreadyUsed",
    eligible: "recoveryDetail.followUpEligible",
    unavailable: "recoveryDetail.followUpUnavailable",
  }[followUpDisplayState(detail)];
  return (
    <section className="recovery-detail__outreach-status" aria-labelledby="outreach-heading">
      <h2 id="outreach-heading">{t("recoveryDetail.outreachStatus")}</h2>
      <dl>
        <div>
          <dt>{t("pending.status")}</dt>
          <dd>{status(detail.status)}</dd>
        </div>
        <div>
          <dt>{t("recoveryDetail.initialOutreach")}</dt>
          <dd>{initial ? <>{t("chart.statusSent")} · {stamp(initial)}</> : t("recoveryDetail.initialNotRecorded")}</dd>
        </div>
        <div>
          <dt>{t("recoveryDetail.followUpStatus")}</dt>
          <dd>{t(followUpKey)}</dd>
        </div>
      </dl>
    </section>
  );
}
