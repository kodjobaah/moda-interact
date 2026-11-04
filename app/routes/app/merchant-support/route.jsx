import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { RouterContextProvider, Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import {
  AuthoredSupportBodySchema,
  countUnicodeGraphemes,
} from "@modainteract/moda-interact-shared/merchant-communications";
import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { assertSupportShop } from "@/services/shop/shop-access-policy";
import { merchantUiContext, createMerchantI18n } from "@/utils/merchant-i18n";
import {
  composeMerchantMessage,
  markMerchantSupportMessageRead,
  markMerchantSupportMessagesRead,
  readMerchantSupportMessages,
} from "@/services/merchant-support/merchant-support.service";
import {
  getMerchantSystemMessageAction,
  getRecoverySupportMessageAction,
} from "@/services/merchant-support/system-message-actions";
import { resolveMerchantExperienceState } from "@/services/shop/merchant-route-access-policy";
import { recordMerchantSupportSendFailure } from "@/services/merchant-support/merchant-support-observability.server";

/** @param {{ request: Request, context?: Readonly<import("react-router").RouterContextProvider> }} args */
export async function loader({ request, context = new RouterContextProvider() }) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { session } } = merchant;
  assertSupportShop(shop, { route: "/app/merchant-support", capability: "read-messages", redirectTo: "/auth/login" });
  const url = new URL(request.url);
  const support = await readMerchantSupportMessages({
    shopId: shop.id,
    page: Number(url.searchParams.get("page") ?? "1"),
    pageSize: Number(url.searchParams.get("pageSize") ?? "25"),
  });
  const scalar = await merchant.readSubscription();
  const subscription = scalar && ["ACTIVE", "TRIALING"].includes(scalar.status) ? scalar : null;
  const merchantExperienceState = resolveMerchantExperienceState({ shop, subscription });
  return Response.json({ ...support, merchantUi: merchantUiContext(shop, session), merchantExperienceState });
}

/** @param {{ request: Request, context?: Readonly<import("react-router").RouterContextProvider> }} args */
export async function action({ request, context = new RouterContextProvider() }) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { session } } = merchant;
  assertSupportShop(shop, { route: "/app/merchant-support", capability: "send-message", redirectTo: "/auth/login" });
  // Bound bytes before invoking the form parser, including multipart overhead.
  const reader = request.body?.getReader();
  const parts = []; let bytes = 0;
  if (reader) {
    try {
      while (bytes <= 65_536) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          return Response.json({ marked: false, errorCode: "SEND_FAILED" }, { status: 413 });
        }
        parts.push(next.value);
      }
    } finally { reader.releaseLock(); }
  }
  let formData;
  try {
    formData = await new Response(new Blob(parts), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
  } catch { return Response.json({ marked: false }, { status: 400 }); }

  const intent = String(formData.get("intent") ?? "compose");

  if (intent === "read-batch") {
    const keys = [...formData.keys()];
    if (keys.length !== 2 || formData.getAll("intent").length !== 1 || formData.getAll("messageIds").length !== 1 ||
      keys.some(key => !["intent", "messageIds"].includes(key))) return Response.json({ marked: false }, { status: 400 });
    let messageIds;
    try { messageIds = JSON.parse(String(formData.get("messageIds"))); } catch { return Response.json({ marked: false }, { status: 400 }); }
    if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 50 ||
      messageIds.some(id => typeof id !== "string" || !id.trim() || id.length > 191) || new Set(messageIds).size !== messageIds.length)
      return Response.json({ marked: false }, { status: 400 });
    return Response.json(await markMerchantSupportMessagesRead({ shopId: shop.id, messageIds }));
  }

  if (intent === "read") {
    return Response.json({
      marked: await markMerchantSupportMessageRead({
        shopId: shop.id,
        messageId: String(formData.get("messageId") ?? ""),
      }),
    });
  }

  if (intent !== "compose") {
    return Response.json({ errorCode: "UNSUPPORTED_ACTION" }, { status: 400 });
  }

  const authoredBody = AuthoredSupportBodySchema.safeParse(String(formData.get("body") ?? ""));
  if (!authoredBody.success) {
    return Response.json({ errorCode: "SEND_FAILED" }, { status: 400 });
  }

  try {
    return Response.json(await composeMerchantMessage({
      shopId: shop.id,
      body: authoredBody.data,
      shopifyUserId: session.onlineAccessInfo?.associated_user?.id?.toString() ?? null,
    }));
  } catch (error) {
    recordMerchantSupportSendFailure(shop.id, error);
    return Response.json({ errorCode: "SEND_FAILED" }, { status: 400 });
  }
}

export default function MerchantSupport() {
  const support = useLoaderData();
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const i18n = createMerchantI18n(support.merchantUi);
  const [body, setBody] = useState("");
  const [validationError, setValidationError] = useState("");
  const actionError = fetcher.data?.errorCode === "UNSUPPORTED_ACTION"
    ? i18n.t("support.unsupportedAction")
    : fetcher.data?.errorCode === "SEND_FAILED"
      ? i18n.t("support.sendFailed")
      : "";
  const messages = support.items ?? [];
  const graphemeCount = useMemo(() => countGraphemes(body), [body]);
  const unreadMessages = messages.filter((/** @type {any} */ message) => (
    ["ADMINISTRATIVE", "SYSTEM"].includes(message.kind)
    && message.state === "AVAILABLE"
    && !message.readAt
  ));
  const unreadMessageIds = unreadMessages.map((/** @type {any} */ message) => message.id);
  const unreadMessageKey = JSON.stringify(unreadMessageIds);

  useEffect(() => {
    let cancelled = false;
    void markUnreadMessages({
      messageIds: JSON.parse(unreadMessageKey),
      revalidate,
      isCancelled: () => cancelled,
    });
    return () => { cancelled = true; };
  }, [unreadMessageKey, revalidate]);

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  function submitMessage(event) {
    event.preventDefault();
    try {
      AuthoredSupportBodySchema.parse(body);
    } catch {
      setValidationError(i18n.t("support.messageLengthError", { max: 500 }));
      return;
    }
    setValidationError("");
    fetcher.submit({ intent: "compose", body }, { method: "post" });
    setBody("");
  }

  return (
    <s-page heading={i18n.t("merchantNav.support")}>
      <div className="merchant-support-page moda-page-shell moda-page-shell--narrow">
        <s-section heading={i18n.t("support.thread")}>
          {messages.length === 0 ? <p>{i18n.t("support.empty")}</p> : <ol className="merchant-support-thread">
            {messages.map((/** @type {any} */ message) => <MessageCard key={message.id} message={message} i18n={i18n} merchantExperienceState={support.merchantExperienceState} />)}
          </ol>}
          {support.totalPages > 1 ? <nav className="merchant-support-pagination" aria-label={i18n.t("support.paginationLabel")}>
            {support.page > 1 ? <Link to={`/app/merchant-support?page=${support.page - 1}`}>{i18n.t("support.previous")}</Link> : <span aria-disabled="true">{i18n.t("support.previous")}</span>}
            <span>{i18n.t("support.page", {
              page: i18n.formatNumber(support.page),
              totalPages: i18n.formatNumber(support.totalPages),
            })}</span>
            {support.page < support.totalPages ? <Link to={`/app/merchant-support?page=${support.page + 1}`}>{i18n.t("support.next")}</Link> : <span aria-disabled="true">{i18n.t("support.next")}</span>}
          </nav> : null}
        </s-section>
        <s-section heading={i18n.t("support.contactHeading")}>
          <form className="merchant-support-compose" onSubmit={submitMessage} noValidate>
            <label htmlFor="message-body">{i18n.t("support.messageLabel")}</label>
            <textarea id="message-body" value={body} onChange={(event) => setBody(event.target.value)} aria-describedby="message-count message-error" required />
            <div id="message-count" aria-live="polite">{i18n.formatNumber(graphemeCount)}/{i18n.formatNumber(500)}</div>
            {validationError || actionError ? <p id="message-error" role="alert">{validationError || actionError}</p> : null}
            <button type="submit" disabled={fetcher.state !== "idle"}>{fetcher.state === "submitting" ? i18n.t("support.sending") : i18n.t("support.send")}</button>
          </form>
        </s-section>
      </div>
    </s-page>
  );
}

export const countGraphemes = countUnicodeGraphemes;

/** @param {{ messageIds: string[], revalidate: () => void, fetchImpl?: typeof fetch, isCancelled?: () => boolean }} args */
export async function markUnreadMessages({
  messageIds,
  revalidate,
  fetchImpl = fetch,
  isCancelled = () => false,
}) {
  const unreadIds = messageIds.filter(Boolean);
  if (unreadIds.length === 0) return false;

  if (isCancelled()) return false;
  try {
    const form = new FormData();
    form.set("intent", "read-batch");
    form.set("messageIds", JSON.stringify(unreadIds));
    const response = await fetchImpl("/app/merchant-support", { method: "POST", body: form, credentials: "include" });
    if (!response.ok) return false;
    const result = await response.json();
    if (result?.marked !== true || isCancelled()) return false;
    revalidate();
    return true;
  } catch { return false; }
}

/** @param {{ message: any, i18n: any, merchantExperienceState: string }} props */
function MessageCard({ message, i18n, merchantExperienceState }) {
  const isMerchant = message.kind === "MERCHANT";
  const label = isMerchant ? i18n.t("support.you") : message.kind === "SYSTEM" ? i18n.t("support.system") : i18n.t("support.modaSupport");
  const hasTranslation = message.isTranslated === true;
  const [showOriginal, setShowOriginal] = useState(false);
  const unavailable = !isMerchant && message.displayBody === null;
  const recoveryAction = message.kind === "SYSTEM" && message.state === "AVAILABLE"
    ? getRecoverySupportMessageAction({
      systemCode: message.systemCode,
      systemVersion: message.systemVersion,
      checkoutRecoveryId: message.checkoutRecoveryId,
      merchantExperienceState: /** @type {import("@/services/shop/merchant-route-access-policy").MerchantExperienceState} */ (merchantExperienceState),
    })
    : null;
  const systemAction = recoveryAction ?? (message.kind === "SYSTEM"
        ? getMerchantSystemMessageAction(
          message.systemCode,
          /** @type {import("@/services/shop/merchant-route-access-policy").MerchantExperienceState} */ (merchantExperienceState),
        )
    : null);

  return (
    <li className={`merchant-support-message merchant-support-message-${message.kind.toLowerCase()}`}>
      <div className="merchant-support-message-header">
        <strong>{label}</strong>
        <time dateTime={message.createdAt}>{i18n.formatDateTime(message.createdAt)}</time>
      </div>
      {unavailable ? <p role="status">{message.state === "FAILED" ? i18n.t("support.translationUnavailable") : i18n.t("support.translationProcessing")}</p> : <p dir="auto">{showOriginal ? message.originalBody : message.displayBody}</p>}
      {hasTranslation ? <button type="button" onClick={() => setShowOriginal((current) => !current)}>{showOriginal ? i18n.t("support.viewTranslation") : i18n.t("support.viewOriginal")}</button> : null}
      {systemAction ? (
        <Link to={systemAction.href}>
          {i18n.t(systemAction.labelKey)}
        </Link>
      ) : null}
    </li>
  );
}

MessageCard.propTypes = {
  message: PropTypes.shape({
    id: PropTypes.string.isRequired,
    kind: PropTypes.oneOf(["ADMINISTRATIVE", "SYSTEM", "MERCHANT"]).isRequired,
    state: PropTypes.oneOf(["PROCESSING", "AVAILABLE", "FAILED"]).isRequired,
    originalBody: PropTypes.string.isRequired,
    displayBody: PropTypes.string,
    isTranslated: PropTypes.bool,
    systemCode: PropTypes.string,
    systemVersion: PropTypes.string,
    checkoutRecoveryId: PropTypes.string,
    createdAt: PropTypes.string.isRequired,
  }).isRequired,
  i18n: PropTypes.shape({
    t: PropTypes.func.isRequired,
    formatDateTime: PropTypes.func.isRequired,
  }).isRequired,
  merchantExperienceState: PropTypes.string.isRequired,
};
