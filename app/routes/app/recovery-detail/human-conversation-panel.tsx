import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import type { Detail } from "./state";
import type { Stamp, Translate } from "./recovery-ui-types";
import { ConversationControlBar, MessagingAvailability } from "./conversation-control-bar";
import { MerchantReplyComposer } from "./merchant-reply-composer";
import { MerchantCommandStatus, isTerminalMerchantCommandState } from "./merchant-command-status";
import { RecoveryActionFeedback } from "./recovery-message-guidance";

type ControlResult = {
  controlMode?: "AI" | "HUMAN";
  controlRevision?: number;
  error?: string;
  currentControl?: { controlMode: "AI" | "HUMAN"; controlRevision: number };
};
type SendResult = { commandId?: string; kind?: string; error?: string; state?: string };
type StatusResult = {
  commandId?: string;
  state?: string;
  moderation?: string;
  providerStatus?: string | null;
  failureCode?: string | null;
  nextAttemptAt?: string | null;
  error?: string;
};

/** The command controller is not an authorisation boundary; the server revalidates atomically. */
export function HumanConversationPanel({ detail, templates, t, stamp, embed, onRefresh, onMessagesRefresh, children }: {
  detail: Detail;
  templates: { id: string; name: string; language: string; purpose?: "FOLLOW_UP_NO_OFFER" | "FOLLOW_UP_CODE_OFFER" | "FOLLOW_UP_AUTOMATIC_OFFER" }[];
  t: Translate;
  stamp: Stamp;
  embed: Record<string, string | undefined>;
  onRefresh: () => void;
  onMessagesRefresh: () => void;
  children: ReactNode;
}) {
  const control = useFetcher<ControlResult>();
  const send = useFetcher<SendResult>();
  const status = useFetcher<StatusResult>();
  const [body, setBody] = useState("");
  const [variant, setVariant] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const idempotencyKey = useRef<string | null>(null);
  const controlGate = useRef(false);
  const sendGate = useRef(false);
  const lastControl = useRef<string | null>(null);
  const lastSend = useRef<string | null>(null);
  const lastTerminalSync = useRef<string | null>(null);
  const conversation = detail.conversation;
  const mode = conversation?.controlMode ?? "AI";
  const suspended = conversation?.humanMessagingStatus === "SUSPENDED";
  const terminal = ["COMPLETED", "EXPIRED", "CANCELLED"].includes(detail.status ?? "");
  const expires = conversation?.windowExpiresAt;
  const open = Boolean(expires && now < Date.parse(expires));
  const commandId = send.data?.commandId ?? conversation?.latestCommand?.commandId ?? null;
  const currentStatus = status.data?.commandId === commandId ? status.data : null;
  const persisted = conversation?.latestCommand?.commandId === commandId ? conversation.latestCommand : null;
  const deliveryState = currentStatus?.state ?? (send.data?.commandId === commandId ? send.data.state : null) ?? persisted?.state ?? null;
  const moderation = currentStatus?.moderation ?? persisted?.moderation ?? "PENDING";
  const statusUrl = commandId ? `/app/recoveries/${encodeURIComponent(detail.id)}/commands/${encodeURIComponent(commandId)}?${
    new URLSearchParams(Object.entries(embed).filter((row): row is [string, string] => typeof row[1] === "string"))
  }` : null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    // Revalidation may retire or replace a selected publication. Never leave a
    // stale selection armed while the server is showing a different catalogue.
    if (variant && !templates.some((row) => row.id === variant)) {
      setVariant("");
      idempotencyKey.current = null;
    }
  }, [variant, templates]);
  useEffect(() => {
    if (control.state === "idle") controlGate.current = false;
    if (control.data?.controlRevision !== undefined) {
      const identity = `${control.data.controlMode}:${control.data.controlRevision}`;
      if (lastControl.current !== identity) {
        lastControl.current = identity;
        onRefresh();
      }
    }
  }, [control.state, control.data, onRefresh]);
  useEffect(() => {
    if (send.state === "idle") sendGate.current = false;
    if (send.data?.commandId && lastSend.current !== send.data.commandId) {
      lastSend.current = send.data.commandId;
      idempotencyKey.current = null;
      setBody("");
      onRefresh();
      onMessagesRefresh();
    }
  }, [send.state, send.data, onRefresh, onMessagesRefresh]);
  useEffect(() => {
    // Terminal status can arrive after the initial admission read. Refresh the
    // transcript once per observed outcome, not on every render/poll cycle.
    if (!commandId || send.data?.commandId !== commandId ||
        !isTerminalMerchantCommandState(deliveryState)) return;
    const outcome = `${commandId}:${deliveryState}:${currentStatus?.providerStatus ?? ""}`;
    if (lastTerminalSync.current === outcome) return;
    lastTerminalSync.current = outcome;
    onMessagesRefresh();
  }, [commandId, send.data?.commandId, deliveryState, currentStatus?.providerStatus, onMessagesRefresh]);
  useEffect(() => {
    if (!statusUrl || isTerminalMerchantCommandState(deliveryState) ||
      isTerminalMerchantCommandState(currentStatus?.providerStatus)) return;
    status.load(statusUrl);
    const timer = setInterval(() => {
      if (status.state === "idle") status.load(statusUrl);
    }, 4_000);
    return () => clearInterval(timer);
    // Retain the existing polling lifecycle; a response must not restart its own poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusUrl, deliveryState, moderation, currentStatus?.providerStatus]);

  const submit = (url: string, payload: Record<string, string | number>, destination: typeof control | typeof send) => {
    destination.submit(payload, { action: url, method: "post", encType: "application/json" });
  };
  const base = `/app/recoveries/${encodeURIComponent(detail.id)}`;
  const changeMode = (targetMode: "AI" | "HUMAN") => {
    if (!conversation || control.state !== "idle" || controlGate.current) return;
    controlGate.current = true;
    submit(`${base}/control`, { targetMode, expectedControlRevision: conversation.controlRevision }, control);
  };
  const reply = (kind: "HUMAN_TEXT" | "RECOVERY_FOLLOW_UP_TEMPLATE") => {
    if (!conversation || send.state !== "idle" || sendGate.current ||
        kind === "RECOVERY_FOLLOW_UP_TEMPLATE" && !templates.some((row) => row.id === variant)) return;
    sendGate.current = true;
    idempotencyKey.current ??= crypto.randomUUID();
    submit(`${base}/commands`, {
      kind, expectedControlRevision: conversation.controlRevision, idempotencyKey: idempotencyKey.current,
      ...(kind === "HUMAN_TEXT" ? { textBody: body } : { templateVariantId: variant }),
    }, send);
  };
  if (!conversation) return (
    <div className="recovery-detail__human">
      <div className="recovery-detail__availability" role="status">
        <strong>{t("recoveryDetail.takeOverUnavailable")}</strong>
        <p>{t("recoveryDetail.takeOverNoConversation")}</p>
      </div>
      <div className="recovery-detail__human-transcript">{children}</div>
    </div>
  );

  return (
    <div className="recovery-detail__human">
      <ConversationControlBar mode={mode} terminal={terminal} suspended={suspended}
        busy={control.state !== "idle"} onChange={changeMode} t={t} />
      <MessagingAvailability conversation={conversation} recoveryStatus={detail.status} suspended={suspended}
        open={open} t={t} stamp={stamp} />
      <RecoveryActionFeedback action="control" code={control.data?.error} t={t} />
      <RecoveryActionFeedback action="send" code={send.data?.error} t={t} />
      <div className="recovery-detail__human-transcript">{children}</div>
      <MerchantReplyComposer conversation={conversation} terminal={terminal} suspended={suspended} open={open}
        templates={templates} body={body} variant={variant} busy={send.state !== "idle"}
        onBodyChange={(value) => { setBody(value); idempotencyKey.current = null; }}
        onVariantChange={(value) => { setVariant(value); idempotencyKey.current = null; }}
        onReply={reply} t={t} />
      <MerchantCommandStatus commandId={commandId} moderation={moderation} deliveryState={deliveryState}
        providerStatus={currentStatus?.providerStatus ?? null} statusBusy={status.state !== "idle"}
        onRefresh={() => { if (statusUrl) status.load(statusUrl); }} t={t} />
    </div>
  );
}
