import type { DetailData, Detail } from "./state";
import type { MerchantI18n, Money, Stamp, Translate } from "./recovery-ui-types";
import { CheckoutBasket } from "./checkout-basket";
import { RecoveryActivityTimeline } from "./recovery-activity-timeline";
import { RelatedRecoveries } from "./related-recoveries";

export function RecoverySidebar({ detail, data, t, i18n, money, stamp, status }: {
  detail: Detail;
  data: DetailData;
  t: Translate;
  i18n: MerchantI18n;
  money: Money;
  stamp: Stamp;
  status: (value: string | null) => string;
}) {
  return (
    <aside className="recovery-detail__sidebar" aria-labelledby="recovery-context-heading">
      <CheckoutBasket basket={detail.basket} t={t} money={money} />
      <h2 className="recovery-detail__visually-hidden" id="recovery-context-heading">{t("recoveryDetail.context")}</h2>
      <RecoveryActivityTimeline detail={detail} t={t} stamp={stamp} />
      <RelatedRecoveries detailId={detail.id} initial={data.related} filters={data.filters} embed={data.embed}
        i18n={i18n} t={t} status={status} money={money} />
    </aside>
  );
}
