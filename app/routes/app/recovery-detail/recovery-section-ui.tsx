import type { Translate } from "./recovery-ui-types";

export function RecoverySectionError({ state, onRetry, onReset, t }: {
  state: string;
  onRetry: () => void;
  onReset: () => void;
  t: Translate;
}) {
  return (
    <div role="alert" className="recovery-detail__section-error">
      <p>{t(state === "invalid" ? "recoveries.invalid.cursor" : state === "unavailable" ? "recoveryDetail.unavailable" : "recoveryDetail.sectionError")}</p>
      <button type="button" onClick={onRetry}>{t("pending.refresh")}</button>
      {state === "invalid" ? <button type="button" onClick={onReset}>{t("recoveryDetail.first")}</button> : null}
    </div>
  );
}

export function RecoverySectionPaging({ t, label, busy, previousCursor, nextCursor, onPrevious, onNext, onLatest }: {
  t: Translate;
  label: string;
  busy: boolean;
  previousCursor: string | null | undefined;
  nextCursor: string | null | undefined;
  onPrevious: () => void;
  onNext: () => void;
  onLatest?: () => void;
}) {
  return (
    <nav className="recovery-detail__paging" aria-label={label}>
      <button type="button" disabled={busy || !previousCursor} onClick={onPrevious}>{t("usage.previous")}</button>
      {onLatest ? <button type="button" disabled={busy} onClick={onLatest}>{t("recoveryDetail.latest")}</button> : null}
      <button type="button" disabled={busy || !nextCursor} onClick={onNext}>{t("usage.next")}</button>
    </nav>
  );
}
