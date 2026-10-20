import { Link } from "react-router";
import type { DetailData, Related } from "./state";
import { recoveryDetailUrl, sectionUrl } from "./state";
import type { MerchantI18n, Money, Translate } from "./recovery-ui-types";
import { useRecoverySection } from "./use-recovery-section";
import { RecoverySectionError, RecoverySectionPaging } from "./recovery-section-ui";

/** Related recoveries are secondary context and can be collapsed independently. */
export function RelatedRecoveries({ detailId, initial, filters, embed, i18n, t, status, money }: {
  detailId: string;
  initial: DetailData["related"];
  filters: DetailData["filters"];
  embed: DetailData["embed"];
  i18n: MerchantI18n;
  t: Translate;
  status: (value: string | null) => string;
  money: Money;
}) {
  const related = useRecoverySection<Related>(initial, sectionUrl(detailId, "related", embed));
  const page = related.result.page;
  return (
    <details className="recovery-detail__card recovery-detail__related-card" open={Boolean(page?.items.length)}>
      <summary><h2 id="related-heading" ref={related.heading} tabIndex={-1}>{t("recoveryDetail.related")}</h2></summary>
      <div aria-busy={related.busy}>
        <button type="button" disabled={related.busy} onClick={() => related.load()}>{t("pending.refresh")}</button>
        {related.busy ? (
          <p role="status">{t("recoveries.loading")}</p>
        ) : related.result.state !== "ready" ? (
          <RecoverySectionError state={related.result.state} t={t} onRetry={() => related.load()}
            onReset={() => related.load(sectionUrl(detailId, "related", embed))} />
        ) : !page?.items.length ? (
          <p>{t("recoveryDetail.noRelated")}</p>
        ) : (
          <ul className="recovery-detail__related">
            {page.items.map((row) => (
              <li key={row.id}>
                <Link to={recoveryDetailUrl(row.id, filters, embed)}>
                  {t("recoveries.checkout", { date: i18n.formatDateTime(row.detectedAt, { year: "numeric" }) })}
                </Link>
                <p>{status(row.status)} · {money(row.value)}</p>
              </li>
            ))}
          </ul>
        )}
        <RecoverySectionPaging t={t} label={t("recoveryDetail.related")} busy={related.busy}
          previousCursor={page?.previousCursor} nextCursor={page?.nextCursor}
          onPrevious={() => related.load(sectionUrl(detailId, "related", embed, page?.previousCursor))}
          onNext={() => related.load(sectionUrl(detailId, "related", embed, page?.nextCursor))} />
      </div>
    </details>
  );
}
