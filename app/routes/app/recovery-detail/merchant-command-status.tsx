import type { Translate } from "./recovery-ui-types";

const terminalStates = new Set(["SENT", "DELIVERED", "READ", "FAILED", "CANCELLED", "UNKNOWN"]);
const knownStates = new Set([
  "PENDING", "ACCEPTED", "CLAIMED", "DISPATCH_ADMITTED", ...terminalStates,
]);

export function isTerminalMerchantCommandState(value: string | null | undefined): boolean {
  return terminalStates.has(value ?? "");
}

export function MerchantCommandStatus({ commandId, moderation, deliveryState, providerStatus, statusBusy, onRefresh, t }: {
  commandId: string | null;
  moderation: string;
  deliveryState: string | null;
  providerStatus: string | null;
  statusBusy: boolean;
  onRefresh: () => void;
  t: Translate;
}) {
  if (!commandId) return null;
  // Provider PENDING must not hide a terminal command outcome (especially
  // UNKNOWN, which is uncertain and must not invite a duplicate retry).
  const reportedState =
    (providerStatus && terminalStates.has(providerStatus) ? providerStatus : null) ??
    (deliveryState && terminalStates.has(deliveryState) ? deliveryState : null) ??
    providerStatus ?? deliveryState ?? "UNKNOWN";
  // Never construct an ICU lookup from an arbitrary provider or database value.
  // The fallback is deliberately conservative: it does not claim delivery.
  const safeState = knownStates.has(reportedState) ? reportedState : "UNKNOWN";
  const resolvedOutcome = terminalStates.has(safeState);
  const visibleStatus = moderation === "BLOCK" ? "recoveryDetail.moderationBlocked" :
    resolvedOutcome ? `recoveryDetail.sendStatus.${safeState}` :
    moderation === "REVIEW_REQUIRED" ? "recoveryDetail.moderationReview" :
    moderation === "RETRYABLE_ERROR" ? "recoveryDetail.moderationRetry" :
    (moderation === "PENDING" || moderation === "CHECKING") ? "recoveryDetail.moderationChecking" :
    `recoveryDetail.sendStatus.${safeState}`;
  const failed = ["FAILED", "CANCELLED"].includes(safeState);
  const queued = !resolvedOutcome;
  return (
    <div role="status" aria-live="polite" className="recovery-detail__command-status">
      <strong>{t("recoveryDetail.latestReply")}</strong>
      <p>{t(visibleStatus)}</p>
      {failed ? <p>{t("recoveryDetail.sendFailed")}</p> : null}
      {queued ? <p className="recovery-detail__muted">{t("recoveryDetail.queuedNotSent")}</p> : null}
      <button type="button" disabled={statusBusy} onClick={onRefresh}>{t("recoveryDetail.refreshStatus")}</button>
    </div>
  );
}
