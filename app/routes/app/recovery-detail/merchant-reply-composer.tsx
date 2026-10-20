import type { Detail } from "./state";
import type { Translate } from "./recovery-ui-types";
import { DisabledMerchantComposer } from "./recovery-message-guidance";

type Template = { id: string; name: string; language: string };

/** Presentation only. The owning controller generates idempotency IDs and submits commands. */
export function MerchantReplyComposer({ conversation, terminal, suspended, open, templates, body, variant,
  busy, onBodyChange, onVariantChange, onReply, t }: {
  conversation: NonNullable<Detail["conversation"]>;
  terminal: boolean;
  suspended: boolean;
  open: boolean;
  templates: Template[];
  body: string;
  variant: string;
  busy: boolean;
  onBodyChange: (value: string) => void;
  onVariantChange: (value: string) => void;
  onReply: (kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE") => void;
  t: Translate;
}) {
  if (terminal) return null;
  const human = conversation.controlMode === "HUMAN";
  const canSend = human && !suspended && !busy;
  if (!human) {
    const replyPossible = !suspended && (open || (conversation.followUp.eligible &&
      !conversation.followUp.used && conversation.followUp.hasApprovedTemplate));
    return replyPossible ? <div className="recovery-detail__reply-placeholder" role="status">
      {t("recoveryDetail.takeOverToReply")}
    </div> : null;
  }
  return (
    <div className="recovery-detail__composer">
      {suspended ? (
        <DisabledMerchantComposer reasonKey="recoveryDetail.humanSuspended" t={t} />
      ) : open ? (
        <>
          <label htmlFor="human-reply">{t("recoveryDetail.reply")}</label>
          <textarea id="human-reply" dir="auto" rows={3} maxLength={4000} value={body}
            disabled={busy} onChange={(event) => onBodyChange(event.target.value)} />
          <div className="recovery-detail__composer-actions">
            <p className="recovery-detail__muted">{t("recoveryDetail.queuedNotSent")}</p>
            <button type="button" disabled={!canSend || !body.trim()} onClick={() => onReply("HUMAN_TEXT")}>
              {t("recoveryDetail.sendReply")}
            </button>
          </div>
        </>
      ) : conversation.followUp.used ? (
        <DisabledMerchantComposer reasonKey="recoveryDetail.followUpAlreadyUsed" t={t} />
      ) : !conversation.followUp.eligible ? (
        <DisabledMerchantComposer reasonKey="recoveryDetail.windowClosedHelp" t={t} />
      ) : !conversation.followUp.hasApprovedTemplate || !templates.length ? (
        <DisabledMerchantComposer reasonKey="recoveryDetail.templateUnavailable" t={t} />
      ) : (
        <>
          <label htmlFor="recovery-follow-up-template">{t("recoveryDetail.followUpTemplate")}</label>
          <select id="recovery-follow-up-template" value={variant} disabled={busy}
            onChange={(event) => onVariantChange(event.target.value)}>
            <option value="">{t("recoveryDetail.selectTemplate")}</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>{template.name} ({template.language})</option>
            ))}
          </select>
          <div className="recovery-detail__composer-actions">
            <p className="recovery-detail__muted">{t("recoveryDetail.followUpCreditNotice")}</p>
            <button type="button" disabled={!canSend || !variant} onClick={() => onReply("RECOVERY_FOLLOW_UP_TEMPLATE")}>
              {t("recoveryDetail.sendTemplate")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
