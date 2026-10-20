import type { DetailData, Detail, Messages } from "./state";
import { sectionUrl } from "./state";
import type { MerchantI18n, Stamp, Translate } from "./recovery-ui-types";
import { useRecoverySection } from "./use-recovery-section";
import { RecoverySectionError, RecoverySectionPaging } from "./recovery-section-ui";
import { HumanConversationPanel } from "./human-conversation-panel";
import { RecoveryMessageList } from "./recovery-message-list";

export function RecoveryConversationThread({ detail, data, t, i18n, stamp, onRefresh }: {
  detail: Detail;
  data: DetailData;
  t: Translate;
  i18n: MerchantI18n;
  stamp: Stamp;
  onRefresh: () => void;
}) {
  const messages = useRecoverySection<Messages>(data.messages, sectionUrl(detail.id, "messages", data.embed));
  const page = messages.result.page;
  return (
    <section className="recovery-detail__card recovery-detail__conversation" aria-labelledby="transcript-heading" aria-busy={messages.busy}>
      <div className="recovery-detail__section-heading">
        <div>
          <h2 id="transcript-heading" tabIndex={-1} ref={messages.heading}>{t("chart.conversation")}</h2>
          <p className="recovery-detail__muted">{t("recoveries.zone", { zone: data.merchantUi.timeZone })}</p>
        </div>
        <button type="button" disabled={messages.busy} onClick={() => messages.load()}>{t("pending.refresh")}</button>
      </div>
      <HumanConversationPanel detail={detail} templates={data.templates} t={t} stamp={stamp}
        embed={data.embed} onRefresh={onRefresh}
        onMessagesRefresh={() => messages.load(sectionUrl(detail.id, "messages", data.embed, null, true), false)}>
        {messages.busy ? (
          <div role="status" className="recovery-detail__skeleton">{t("recoveries.loading")}</div>
        ) : messages.result.state !== "ready" ? (
          <RecoverySectionError state={messages.result.state} onRetry={() => messages.load()}
            onReset={() => messages.load(sectionUrl(detail.id, "messages", data.embed))} t={t} />
        ) : !page?.items.length ? (
          <p role="status">{t(detail.hasConversation ? "merchantSupport.thread.empty" : "recoveryDetail.noConversation")}</p>
        ) : (
          <RecoveryMessageList items={page.items} i18n={i18n} stamp={stamp} t={t} />
        )}
        <RecoverySectionPaging t={t} label={t("chart.conversation")} busy={messages.busy}
          previousCursor={page?.previousCursor} nextCursor={page?.nextCursor}
          onPrevious={() => messages.load(sectionUrl(detail.id, "messages", data.embed, page?.previousCursor))}
          onNext={() => messages.load(sectionUrl(detail.id, "messages", data.embed, page?.nextCursor))}
          onLatest={() => messages.load(sectionUrl(detail.id, "messages", data.embed, null, true))} />
      </HumanConversationPanel>
    </section>
  );
}
