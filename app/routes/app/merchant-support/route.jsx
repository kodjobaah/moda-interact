import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import {
  AuthoredSupportBodySchema,
  countUnicodeGraphemes,
} from "@modainteract/moda-interact-shared/merchant-communications";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { merchantUiContext, createMerchantI18n } from "@/utils/merchant-i18n";
import db from "@/db.server";
import {
  composeMerchantMessage,
  markMerchantSupportMessageRead,
  readMerchantSupportMessages,
} from "@/services/merchant-support/merchant-support.service";
import { getMerchantSystemMessageAction } from "@/services/merchant-support/system-message-actions";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  const url = new URL(request.url);
  const support = await readMerchantSupportMessages({
    shopId: shop.id,
    page: Number(url.searchParams.get("page") ?? "1"),
    pageSize: Number(url.searchParams.get("pageSize") ?? "25"),
  });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  return Response.json({ ...support, merchantUi: merchantUiContext(settings, session) });
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "compose");

  if (intent === "read") {
    return Response.json({
      marked: await markMerchantSupportMessageRead({
        shopId: shop.id,
        messageId: String(formData.get("messageId") ?? ""),
      }),
    });
  }

  if (intent !== "compose") {
    return Response.json({ error: "Unsupported merchant support action." }, { status: 400 });
  }

  try {
    return Response.json(await composeMerchantMessage({
      shopId: shop.id,
      body: String(formData.get("body") ?? ""),
      shopifyUserId: session.userId ?? null,
    }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to send message." }, { status: 400 });
  }
}

export default function MerchantSupport() {
  const support = useLoaderData();
  const fetcher = useFetcher();
  const { revalidate } = useRevalidator();
  const i18n = createMerchantI18n(support.merchantUi);
  const [body, setBody] = useState("");
  const [validationError, setValidationError] = useState("");
  const messages = support.items ?? [];
  const graphemeCount = useMemo(() => countGraphemes(body), [body]);
  const unreadMessages = messages.filter((message) => (
    ["ADMINISTRATIVE", "SYSTEM"].includes(message.kind)
    && message.state === "AVAILABLE"
    && !message.readAt
  ));
  const unreadMessageIds = unreadMessages.map((message) => message.id).join(",");

  useEffect(() => {
    let cancelled = false;
    void markUnreadMessages({
      messageIds: unreadMessageIds.split(",").filter(Boolean),
      revalidate,
      isCancelled: () => cancelled,
    });
    return () => { cancelled = true; };
  }, [unreadMessageIds, revalidate]);

  function submitMessage(event) {
    event.preventDefault();
    try {
      AuthoredSupportBodySchema.parse(body);
    } catch {
      setValidationError("Message must contain between 1 and 500 graphemes.");
      return;
    }
    setValidationError("");
    fetcher.submit({ intent: "compose", body }, { method: "post" });
    setBody("");
  }

  return (
    <s-page heading={i18n.t("dashboard.messagesSent")}>
      <s-section heading="Support thread">
        {messages.length === 0 ? <p>No messages yet.</p> : <ol className="merchant-support-thread">
          {messages.map((message) => <MessageCard key={message.id} message={message} i18n={i18n} />)}
        </ol>}
        {support.totalPages > 1 ? <nav className="merchant-support-pagination" aria-label="Support thread pages">
          {support.page > 1 ? <Link to={`/app/merchant-support?page=${support.page - 1}`}>Previous</Link> : <span aria-disabled="true">Previous</span>}
          <span>Page {support.page} of {support.totalPages}</span>
          {support.page < support.totalPages ? <Link to={`/app/merchant-support?page=${support.page + 1}`}>Next</Link> : <span aria-disabled="true">Next</span>}
        </nav> : null}
      </s-section>
      <s-section heading="Contact Moda Support">
        <form className="merchant-support-compose" onSubmit={submitMessage} noValidate>
          <label htmlFor="message-body">Message</label>
          <textarea id="message-body" value={body} onChange={(event) => setBody(event.target.value)} aria-describedby="message-count message-error" required />
          <div id="message-count" aria-live="polite">{graphemeCount}/500</div>
          {validationError || fetcher.data?.error ? <p id="message-error" role="alert">{validationError || fetcher.data.error}</p> : null}
          <button type="submit" disabled={fetcher.state !== "idle"}>{fetcher.state === "submitting" ? "Sending..." : "Send"}</button>
        </form>
      </s-section>
    </s-page>
  );
}

export const countGraphemes = countUnicodeGraphemes;

export async function markUnreadMessages({
  messageIds,
  revalidate,
  fetchImpl = fetch,
  isCancelled = () => false,
}) {
  const unreadIds = messageIds.filter(Boolean);
  if (unreadIds.length === 0) return false;

  let markedCount = 0;
  for (const messageId of unreadIds) {
    if (isCancelled()) return false;
    const form = new FormData();
    form.set("intent", "read");
    form.set("messageId", messageId);
    const response = await fetchImpl("/app/merchant-support", {
      method: "POST",
      body: form,
      credentials: "include",
    });
    if (!response.ok) {
      if (markedCount > 0 && !isCancelled()) revalidate();
      return false;
    }
    const result = await response.json();
    if (result?.marked !== true) {
      if (markedCount > 0 && !isCancelled()) revalidate();
      return false;
    }
    markedCount += 1;
  }

  if (markedCount > 0 && !isCancelled()) revalidate();
  return markedCount > 0;
}

function MessageCard({ message, i18n }) {
  const isMerchant = message.kind === "MERCHANT";
  const label = isMerchant ? "You" : message.kind === "SYSTEM" ? "System" : "Moda Support";
  const hasTranslation = message.isTranslated === true;
  const [showOriginal, setShowOriginal] = useState(false);
  const unavailable = !isMerchant && message.displayBody === null;
  const systemAction = message.kind === "SYSTEM"
    ? getMerchantSystemMessageAction(message.systemCode)
    : null;

  return (
    <li className={`merchant-support-message merchant-support-message-${message.kind.toLowerCase()}`}>
      <div className="merchant-support-message-header">
        <strong>{label}</strong>
        <time dateTime={message.createdAt}>{i18n.formatDateTime(message.createdAt)}</time>
      </div>
      {unavailable ? <p role="status">{message.state === "FAILED" ? "Translation unavailable. Please try again later." : "Translation is processing."}</p> : <p dir="auto">{showOriginal ? message.originalBody : message.displayBody}</p>}
      {hasTranslation ? <button type="button" onClick={() => setShowOriginal((current) => !current)}>{showOriginal ? "View translation" : "View original"}</button> : null}
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
    createdAt: PropTypes.string.isRequired,
  }).isRequired,
  i18n: PropTypes.shape({
    formatDateTime: PropTypes.func.isRequired,
  }).isRequired,
};