import type { Translate } from "./recovery-ui-types";

// The server remains authoritative. Translate only known, bounded reason codes;
// never render raw error objects, provider responses, or request headers.
const controlReasons: Record<string, string> = {
  human_messaging_unavailable: "recoveryDetail.controlEntitlementUnavailable",
  human_messaging_suspended: "recoveryDetail.humanSuspended",
  terminal_recovery: "recoveryDetail.terminal",
  stale_control_revision: "recoveryDetail.staleRevision",
  control_already_selected: "recoveryDetail.controlAlreadySelected",
  forbidden: "recoveryDetail.controlNotAuthorised",
  origin_configuration_unavailable: "recoveryDetail.controlTemporarilyUnavailable",
  internal_error: "recoveryDetail.controlTemporarilyUnavailable",
  conflict_retry: "recoveryDetail.staleRevision",
  not_found: "recoveryDetail.unavailable",
};
const sendReasons: Record<string, string> = {
  service_window_closed: "recoveryDetail.windowClosedHelp",
  follow_up_unavailable: "recoveryDetail.followUpUnavailable",
  stale_control_revision: "recoveryDetail.staleRevision",
  human_messaging_suspended: "recoveryDetail.humanSuspended",
  human_messaging_unavailable: "recoveryDetail.controlEntitlementUnavailable",
  terminal_recovery: "recoveryDetail.terminal",
  recipient_unavailable: "recoveryDetail.recipientUnavailable",
  template_not_allowed: "recoveryDetail.templateRejected",
  not_human_controlled: "recoveryDetail.sendNotHumanControlled",
  idempotency_conflict: "recoveryDetail.sendFailed",
  conflict_retry: "recoveryDetail.staleRevision",
  invalid_request: "recoveryDetail.sendFailed",
  forbidden: "recoveryDetail.controlNotAuthorised",
  origin_configuration_unavailable: "recoveryDetail.controlTemporarilyUnavailable",
  internal_error: "recoveryDetail.sendFailed",
  not_found: "recoveryDetail.unavailable",
};

export function recoveryActionMessageKey(action: "control" | "send", code: string): string {
  return action === "control"
    ? controlReasons[code] ?? "recoveryDetail.controlFailed"
    : sendReasons[code] ?? "recoveryDetail.sendFailed";
}

export function RecoveryActionFeedback({ action, code, t }: {
  action: "control" | "send";
  code: string | undefined;
  t: Translate;
}) {
  return code ? (
    <p role="alert" className="recovery-detail__action-error">{t(recoveryActionMessageKey(action, code))}</p>
  ) : null;
}

export function DisabledMerchantComposer({ reasonKey, t }: { reasonKey: string; t: Translate }) {
  return (
    <div className="recovery-detail__composer recovery-detail__composer--disabled" role="status">
      <label htmlFor="human-reply-disabled">{t("recoveryDetail.reply")}</label>
      <textarea id="human-reply-disabled" rows={2} disabled value=""
        placeholder={t("recoveryDetail.replyDisabledPlaceholder")}
        aria-describedby="human-reply-disabled-reason" />
      <p id="human-reply-disabled-reason" className="recovery-detail__muted">{t(reasonKey)}</p>
      <div className="recovery-detail__composer-actions">
        <button type="button" disabled>{t("recoveryDetail.sendReply")}</button>
      </div>
    </div>
  );
}
