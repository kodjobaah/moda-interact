import type { Detail } from "./state";
import type { Stamp, Translate } from "./recovery-ui-types";
import { followUpDisplayState } from "./recovery-outreach-status";

/** A single ordered timeline: do not repeat the initial send in an outreach summary. */
export function RecoveryActivityTimeline({ detail, t, stamp }: { detail: Detail; t: Translate; stamp: Stamp }) {
  const initial = detail.initialOutreachSentAt ?? detail.milestones.messageSentAt;
  const milestones = [
    { id: "started", label: "recoveries.started", value: detail.milestones.detectedAt },
    { id: "initial", label: "recoveryDetail.initialOutreach", value: initial },
    { id: "engaged", label: "chart.statusEngaged", value: detail.milestones.engagedAt },
    { id: "completed", label: "chart.statusRecovered", value: detail.milestones.completedAt },
    { id: "expired", label: "chart.statusExpired", value: detail.milestones.expiredAt },
  ].filter((item) => item.id === "initial" || Boolean(item.value));
  const followUp = {
    used: "recoveryDetail.followUpAlreadyUsed",
    eligible: "recoveryDetail.followUpEligible",
    unavailable: "recoveryDetail.followUpUnavailable",
  }[followUpDisplayState(detail)];
  return (
    <section className="recovery-detail__card recovery-detail__activity" aria-labelledby="recovery-activity-heading">
      <h2 id="recovery-activity-heading">{t("recoveryDetail.activity")}</h2>
      <ol className="recovery-detail__timeline">
        {milestones.map((item) => (
          <li key={item.id}>
            <strong>{t(item.label)}</strong>
            <span>{item.value ? stamp(item.value) : t("recoveryDetail.initialNotRecorded")}</span>
          </li>
        ))}
      </ol>
      <div className="recovery-detail__follow-up-state">
        <strong>{t("recoveryDetail.followUpStatus")}</strong>
        <span>{t(followUp)}</span>
      </div>
    </section>
  );
}
