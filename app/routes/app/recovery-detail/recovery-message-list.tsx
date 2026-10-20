import { Fragment } from "react";
import type { Messages } from "./state";
import type { MerchantI18n, Stamp, Translate } from "./recovery-ui-types";

/** React text nodes escape HTML. Only explicit credential-free http(s) links become anchors. */
export function MessageText({ text }: { text: string }) {
  return (
    <p className="recovery-detail__text" dir="auto">
      {text.split(/(https?:\/\/[^\s<>]+)/giu).map((part, index) => {
        let safe = false;
        try {
          const url = new URL(part);
          safe = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
        } catch {
          // Keep plain text escaped by React.
        }
        return safe ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part;
      })}
    </p>
  );
}

const senderKeys: Record<string, string> = {
  CUSTOMER: "chart.senderCustomer",
  AGENT: "recoveryDetail.assistant",
  AUTOMATION: "recoveryDetail.automation",
  HUMAN: "recoveryDetail.team",
};
const receiptKeys: Record<string, string> = {
  PENDING: "recoveryDetail.pending",
  SENT: "chart.statusSent",
  DELIVERED: "chart.statusDelivered",
  READ: "recoveryDetail.read",
  FAILED: "chart.statusFailed",
};
const transcriptionKeys: Record<string, string> = {
  PENDING: "recoveryDetail.transcribing",
  REJECTED: "recoveryDetail.rejected",
  FAILED: "recoveryDetail.transcriptionFailed",
};

export function RecoveryMessageList({ items, i18n, t, stamp }: {
  items: Messages["items"];
  i18n: MerchantI18n;
  t: Translate;
  stamp: Stamp;
}) {
  return (
    <ol className="recovery-detail__messages" aria-label={t("chart.conversation")}>
      {items.map((message, index) => {
        const date = i18n.formatDate(message.createdAt);
        return (
          <Fragment key={message.id}>
            {index === 0 || i18n.formatDate(items[index - 1].createdAt) !== date ? (
              <li className="recovery-detail__day">{date}</li>
            ) : null}
            <li className={`recovery-detail__bubble recovery-detail__bubble--${message.direction ?? "unknown"}`}>
              <div className="recovery-detail__message-heading">
                <strong>{t(senderKeys[message.sender ?? ""] ?? "recoveryDetail.unknownSender")}</strong>
                {stamp(message.createdAt)}
              </div>
              {message.content.type === "TEXT" ? (
                <MessageText text={message.content.text ?? t("common.unavailable")} />
              ) : message.content.type === "AUDIO" ? (
                <>
                  <strong>{t("recoveryDetail.voice")}</strong>
                  {message.content.transcriptionStatus === "COMPLETED" && message.content.text ? (
                    <MessageText text={message.content.text} />
                  ) : (
                    <p>{t(transcriptionKeys[message.content.transcriptionStatus ?? ""] ?? "recoveryDetail.transcriptionUnavailable")}</p>
                  )}
                </>
              ) : message.content.templateName ? (
                <p>{t("recoveryDetail.followUpTemplate")}: {message.content.templateName}</p>
              ) : <p>{t("recoveryDetail.unsupported")}</p>}
              {message.sender === "CUSTOMER" && message.moderation === "FLAGGED" ? (
                <p role="status" className="recovery-detail__moderation-warning">{t("recoveryDetail.customerFlagged")}</p>
              ) : null}
              {message.delivery ? (
                <div className="recovery-detail__receipt">
                  <span>{t(message.delivery.commandState ? `recoveryDetail.sendStatus.${message.delivery.commandState}` :
                    message.delivery.unconfirmed ? "recoveryDetail.sendStatus.UNKNOWN" :
                    receiptKeys[message.delivery.status ?? ""] ?? "common.unavailable")}</span>
                  {(["sentAt", "deliveredAt", "readAt"] as const).map((key, n) => message.delivery?.[key] ? (
                    <span key={key}>
                      {t(["chart.statusSent", "chart.statusDelivered", "recoveryDetail.read"][n])}: {stamp(message.delivery[key])}
                    </span>
                  ) : null)}
                </div>
              ) : null}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
