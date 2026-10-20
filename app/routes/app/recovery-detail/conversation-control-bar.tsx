import type { Stamp, Translate } from "./recovery-ui-types";
import type { Detail } from "./state";

/** Advisory UI explanation. The mutation endpoint remains authoritative. */
export function takeOverUnavailableReasonKey(recoveryStatus: Detail["status"], suspended: boolean): string | null {
  switch (recoveryStatus) {
    case "COMPLETED": return "recoveryDetail.takeOverCompleted";
    case "EXPIRED": return "recoveryDetail.takeOverExpired";
    case "CANCELLED": return "recoveryDetail.takeOverCancelled";
    default: return suspended ? "recoveryDetail.takeOverSuspended" : null;
  }
}

export function ConversationControlBar({ mode, terminal, suspended, busy, onChange, t }: {
  mode: "AI" | "HUMAN";
  terminal: boolean;
  suspended: boolean;
  busy: boolean;
  onChange: (target: "AI" | "HUMAN") => void;
  t: Translate;
}) {
  const human = mode === "HUMAN";
  const takeoverDisabled = !human && (terminal || suspended);
  return (
    <div className="recovery-detail__human-controls">
      <p className="recovery-detail__control-state">
        <span className="recovery-detail__control-indicator" aria-hidden="true" />
        <strong>{t(human ? "recoveryDetail.humanMode" : "recoveryDetail.aiMode")}</strong>
      </p>
      <div className="recovery-detail__control-action">
        <button type="button" disabled={busy || takeoverDisabled}
          aria-describedby={busy ? "recovery-control-updating" : takeoverDisabled ? "recovery-takeover-unavailable" : undefined}
          onClick={() => onChange(human ? "AI" : "HUMAN")}>
          {t(human ? "recoveryDetail.resumeAI" : "recoveryDetail.takeOver")}
        </button>
        {busy ? <p id="recovery-control-updating" role="status" className="recovery-detail__muted">
          {t("recoveryDetail.controlUpdating")}
        </p> : null}
      </div>
    </div>
  );
}

/** One advisory location; actual eligibility is rechecked by the command service. */
export function MessagingAvailability({ conversation, recoveryStatus, suspended, open, t, stamp }: {
  conversation: NonNullable<Detail["conversation"]>;
  recoveryStatus: Detail["status"];
  suspended: boolean;
  open: boolean;
  t: Translate;
  stamp: Stamp;
}) {
  const unavailableKey = takeOverUnavailableReasonKey(recoveryStatus, suspended);
  const expires = conversation.windowExpiresAt;
  const followUp = conversation.followUp;
  const followUpDescription = followUp.used ? "recoveryDetail.followUpAlreadyUsed" :
    followUp.eligible && followUp.hasApprovedTemplate ? "recoveryDetail.followUpEligible" : "recoveryDetail.followUpUnavailable";
  return (
    <div className="recovery-detail__availability" role="status">
      {unavailableKey ? (
        <div id="recovery-takeover-unavailable">
          {conversation.controlMode === "AI" ? <strong>{t("recoveryDetail.takeOverUnavailable")}</strong> : null}
          <p>{t(unavailableKey)}</p>
        </div>
      ) : (
        <>
          <p>{t(open ? "recoveryDetail.windowOpen" : "recoveryDetail.windowClosed")}
            {open && expires ? <> · {stamp(expires)}</> : null}
          </p>
          {!open ? <>
            <p className="recovery-detail__muted">{t("recoveryDetail.windowClosedHelp")}</p>
            <p className="recovery-detail__muted">{t(followUpDescription)}</p>
          </> : null}
        </>
      )}
    </div>
  );
}
