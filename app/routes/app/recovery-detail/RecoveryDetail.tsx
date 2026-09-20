import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { createMerchantI18n } from "../../../utils/merchant-i18n";
import { recoveryListUrl } from "../recoveries/recovery-list-state";
import {
  recoveryDetailUrl,
  sectionUrl,
  type DetailData,
  type Messages,
  type Related,
  type Section,
} from "./state";
import "./RecoveryDetail.css";

/** React text nodes escape markup; only explicit http(s) URLs become external links. */
export function MessageText({ text }: { text: string }) {
  return (
    <p className="recovery-detail__text" dir="auto">
      {text.split(/(https?:\/\/[^\s<>]+)/giu).map((part, index) => {
        let safe = false;
        try {
          const url = new URL(part);
          safe =
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password;
        } catch {
          /* Plain text. */
        }
        return safe ? (
          <a key={index} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          part
        );
      })}
    </p>
  );
}

function useSection<T>(initial: Section<T>, initialUrl: string) {
  const fetcher = useFetcher<Section<T>>();
  const [url, setUrl] = useState(initialUrl);
  const heading = useRef<HTMLHeadingElement>(null);
  const requested = useRef(false);
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (!busy && requested.current) {
      heading.current?.focus();
      requested.current = false;
    }
  }, [busy]);
  return {
    result: fetcher.data ?? initial,
    busy,
    heading,
    load: (next = url) => {
      requested.current = true;
      setUrl(next);
      fetcher.load(next);
    },
  };
}

export default function RecoveryDetail({
  data,
  busy = false,
  onRefresh,
}: {
  data: DetailData;
  busy?: boolean;
  onRefresh: () => void;
}) {
  const i18n = createMerchantI18n(data.merchantUi),
    t = i18n.t;
  const { detail, filters, embed } = data;
  const messages = useSection<Messages>(
    data.messages,
    sectionUrl(detail?.id ?? "", "messages", embed),
  );
  const related = useSection<Related>(
    data.related,
    sectionUrl(detail?.id ?? "", "related", embed),
  );
  const money = (value: { amount: string | null; currency: string | null }) => {
    if (value.amount === null || !value.currency)
      return t("common.unavailable");
    try {
      return i18n.formatMoney(value.amount, value.currency);
    } catch {
      return t("common.unavailable");
    }
  };
  const stamp = (value: string) => (
    <time dateTime={value}>
      {i18n.formatDateTime(value, { year: "numeric" })}
    </time>
  );
  const status = (value: string | null) =>
    value ? t(`recoveries.status.${value}`) : t("common.unavailable");
  const person = detail?.customer;
  const name =
    [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim() ||
    person?.email ||
    t("chart.guest");
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
  const milestoneKeys: Record<string, string> = {
    detectedAt: "recoveries.started",
    messageSentAt: "chart.statusMessageSent",
    engagedAt: "chart.statusEngaged",
    completedAt: "chart.statusRecovered",
    expiredAt: "chart.statusExpired",
  };
  const sectionError = (
    state: string,
    refresh: () => void,
    reset: () => void,
  ) => (
    <div role="alert">
      <p>
        {t(
          state === "invalid"
            ? "recoveries.invalid.cursor"
            : state === "unavailable"
              ? "recoveryDetail.unavailable"
              : "recoveryDetail.sectionError",
        )}
      </p>
      <button onClick={refresh}>{t("pending.refresh")}</button>
      {state === "invalid" ? (
        <button onClick={reset}>{t("recoveryDetail.first")}</button>
      ) : null}
    </div>
  );
  return (
    <main className="recovery-detail" aria-busy={busy}>
      <Link
        className="recovery-detail__back"
        to={recoveryListUrl(filters, embed)}
      >
        {t("recoveryDetail.back")}
      </Link>
      {data.state !== "ready" || !detail ? (
        <section className="recovery-detail__card">
          <h1>
            {t(
              data.state === "error"
                ? "recoveryDetail.sectionError"
                : "recoveryDetail.unavailable",
            )}
          </h1>
          {data.state === "error" ? (
            <button disabled={busy} onClick={onRefresh}>
              {t("pending.refresh")}
            </button>
          ) : null}
        </section>
      ) : (
        <>
          <header className="recovery-detail__header">
            <div>
              <p>{t("chart.recoveryDetails")}</p>
              <h1 dir="auto">{name}</h1>
              {person?.email && person.email !== name ? (
                <p dir="auto">{person.email}</p>
              ) : null}
            </div>
            <dl className="recovery-detail__summary">
              <div>
                <dt>{t("recoveries.value")}</dt>
                <dd>{money(detail.value)}</dd>
              </div>
              <div>
                <dt>{t("pending.status")}</dt>
                <dd>{status(detail.status)}</dd>
              </div>
              <div>
                <dt>{t("recoveries.started")}</dt>
                <dd>{stamp(detail.milestones.detectedAt)}</dd>
              </div>
            </dl>
          </header>
          <div className="recovery-detail__layout">
            <section
              className="recovery-detail__card"
              aria-labelledby="transcript-heading"
              aria-busy={messages.busy}
            >
              <div className="recovery-detail__section-heading">
                <h2
                  id="transcript-heading"
                  tabIndex={-1}
                  ref={messages.heading}
                >
                  {t("chart.conversation")}
                </h2>
                <button
                  disabled={messages.busy}
                  onClick={() => messages.load()}
                >
                  {t("pending.refresh")}
                </button>
              </div>
              <p>{t("recoveryDetail.readOnly")}</p>
              <p>{t("recoveries.zone", { zone: data.merchantUi.timeZone })}</p>
              <nav
                className="recovery-detail__paging"
                aria-label={t("chart.conversation")}
              >
                <button
                  disabled={
                    messages.busy || !messages.result.page?.previousCursor
                  }
                  onClick={() =>
                    messages.load(
                      sectionUrl(
                        detail.id,
                        "messages",
                        embed,
                        messages.result.page?.previousCursor,
                      ),
                    )
                  }
                >
                  {t("usage.previous")}
                </button>
                <button
                  disabled={messages.busy}
                  onClick={() =>
                    messages.load(
                      sectionUrl(detail.id, "messages", embed, null, true),
                    )
                  }
                >
                  {t("recoveryDetail.latest")}
                </button>
                <button
                  disabled={messages.busy || !messages.result.page?.nextCursor}
                  onClick={() =>
                    messages.load(
                      sectionUrl(
                        detail.id,
                        "messages",
                        embed,
                        messages.result.page?.nextCursor,
                      ),
                    )
                  }
                >
                  {t("usage.next")}
                </button>
              </nav>
              {messages.busy ? (
                <div role="status" className="recovery-detail__skeleton">
                  {t("recoveries.loading")}
                </div>
              ) : messages.result.state !== "ready" ? (
                sectionError(
                  messages.result.state,
                  () => messages.load(),
                  () => messages.load(sectionUrl(detail.id, "messages", embed)),
                )
              ) : !messages.result.page?.items.length ? (
                <p role="status">
                  {t(
                    detail.hasConversation
                      ? "merchantSupport.thread.empty"
                      : "recoveryDetail.noConversation",
                  )}
                </p>
              ) : (
                <ol className="recovery-detail__messages">
                  {messages.result.page.items.map((message, index, rows) => {
                    const date = i18n.formatDate(message.createdAt);
                    return (
                      <Fragment key={message.id}>
                        {index === 0 ||
                        i18n.formatDate(rows[index - 1].createdAt) !== date ? (
                          <li className="recovery-detail__day">{date}</li>
                        ) : null}
                        <li
                          className={`recovery-detail__bubble recovery-detail__bubble--${message.direction ?? "unknown"}`}
                        >
                          <div className="recovery-detail__message-heading">
                            <strong>
                              {t(
                                senderKeys[message.sender ?? ""] ??
                                  "recoveryDetail.unknownSender",
                              )}
                            </strong>
                            {stamp(message.createdAt)}
                          </div>
                          {message.content.type === "TEXT" ? (
                            <MessageText
                              text={
                                message.content.text ?? t("common.unavailable")
                              }
                            />
                          ) : message.content.type === "AUDIO" ? (
                            <>
                              <strong>{t("recoveryDetail.voice")}</strong>
                              {message.content.transcriptionStatus ===
                                "COMPLETED" && message.content.text ? (
                                <MessageText text={message.content.text} />
                              ) : (
                                <p>
                                  {t(
                                    transcriptionKeys[
                                      message.content.transcriptionStatus ?? ""
                                    ] ??
                                      "recoveryDetail.transcriptionUnavailable",
                                  )}
                                </p>
                              )}
                            </>
                          ) : (
                            <p>{t("recoveryDetail.unsupported")}</p>
                          )}
                          {message.delivery ? (
                            <div className="recovery-detail__receipt">
                              <span>
                                {t(
                                  receiptKeys[message.delivery.status ?? ""] ??
                                    "common.unavailable",
                                )}
                              </span>
                              {(
                                ["sentAt", "deliveredAt", "readAt"] as const
                              ).map((key, n) =>
                                message.delivery?.[key] ? (
                                  <span key={key}>
                                    {t(
                                      [
                                        "chart.statusSent",
                                        "chart.statusDelivered",
                                        "recoveryDetail.read",
                                      ][n],
                                    )}
                                    : {stamp(message.delivery[key])}
                                  </span>
                                ) : null,
                              )}
                            </div>
                          ) : null}
                        </li>
                      </Fragment>
                    );
                  })}
                </ol>
              )}
            </section>
            <aside>
              <details
                className="recovery-detail__card recovery-detail__context"
                open
              >
                <summary>{t("recoveryDetail.context")}</summary>
                <h2>{t("recoveryDetail.milestones")}</h2>
                <dl className="recovery-detail__milestones">
                  {Object.entries(detail.milestones)
                    .filter(([, value]) => value !== null)
                    .map(([key, value]) => (
                      <div key={key}>
                        <dt>{t(milestoneKeys[key])}</dt>
                        <dd>{stamp(value!)}</dd>
                      </div>
                    ))}
                </dl>
                <section
                  aria-labelledby="related-heading"
                  aria-busy={related.busy}
                >
                  <div className="recovery-detail__section-heading">
                    <h2
                      id="related-heading"
                      tabIndex={-1}
                      ref={related.heading}
                    >
                      {t("recoveryDetail.related")}
                    </h2>
                    <button
                      disabled={related.busy}
                      onClick={() => related.load()}
                    >
                      {t("pending.refresh")}
                    </button>
                  </div>
                  {related.busy ? (
                    <p role="status">{t("recoveries.loading")}</p>
                  ) : related.result.state !== "ready" ? (
                    sectionError(
                      related.result.state,
                      () => related.load(),
                      () =>
                        related.load(sectionUrl(detail.id, "related", embed)),
                    )
                  ) : !related.result.page?.items.length ? (
                    <p>{t("recoveryDetail.noRelated")}</p>
                  ) : (
                    <ul className="recovery-detail__related">
                      {related.result.page.items.map((row) => (
                        <li key={row.id}>
                          <Link to={recoveryDetailUrl(row.id, filters, embed)}>
                            {t("recoveries.checkout", {
                              date: i18n.formatDateTime(row.detectedAt, {
                                year: "numeric",
                              }),
                            })}
                          </Link>
                          <p>
                            {status(row.status)} · {money(row.value)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <nav
                    className="recovery-detail__paging"
                    aria-label={t("recoveryDetail.related")}
                  >
                    <button
                      disabled={
                        related.busy || !related.result.page?.previousCursor
                      }
                      onClick={() =>
                        related.load(
                          sectionUrl(
                            detail.id,
                            "related",
                            embed,
                            related.result.page?.previousCursor,
                          ),
                        )
                      }
                    >
                      {t("usage.previous")}
                    </button>
                    <button
                      disabled={
                        related.busy || !related.result.page?.nextCursor
                      }
                      onClick={() =>
                        related.load(
                          sectionUrl(
                            detail.id,
                            "related",
                            embed,
                            related.result.page?.nextCursor,
                          ),
                        )
                      }
                    >
                      {t("usage.next")}
                    </button>
                  </nav>
                </section>
              </details>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
