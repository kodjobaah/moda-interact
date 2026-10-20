import type { RecoveryBasket } from "../../../services/recoveries/recovery-basket";
import type { Money, Translate } from "./recovery-ui-types";

function BasketTotal({ basket, t, money }: { basket: RecoveryBasket; t: Translate; money: Money }) {
  return (
    <div className="recovery-detail__basket-total">
      <span>{t("recoveryDetail.savedTotal")}</span>
      <strong>{money({ amount: basket.recoveryTotal, currency: basket.currency })}</strong>
    </div>
  );
}

/** Missing snapshots remain honest and compact; recorded items remain visible and collapsible. */
export function CheckoutBasket({ basket, t, money }: { basket: RecoveryBasket; t: Translate; money: Money }) {
  if (!basket.items.length && basket.unavailableReason !== null) {
    return (
      <section className="recovery-detail__card recovery-detail__basket" aria-labelledby="basket-heading">
        <h2 id="basket-heading">{t("recoveryDetail.basket")}</h2>
        <BasketTotal basket={basket} t={t} money={money} />
        <p className="recovery-detail__muted" role="status">
          {t(basket.unavailableReason === "partial" ? "recoveryDetail.basketPartial" : "recoveryDetail.basketUnavailable")}
        </p>
      </section>
    );
  }
  return (
    <details className="recovery-detail__card recovery-detail__basket" open>
      <summary id="basket-heading"><h2>{t("recoveryDetail.basket")}</h2></summary>
      <BasketTotal basket={basket} t={t} money={money} />
      {basket.unavailableReason === "partial" ? (
        <p role="status" className="recovery-detail__muted">{t("recoveryDetail.basketPartial")}</p>
      ) : null}
      {basket.items.length ? (
        <>
          <p className="recovery-detail__muted">{t("recoveryDetail.savedSnapshot")}</p>
          <ul className="recovery-detail__basket-list">
            {basket.items.map((item, index) => (
              <li key={index}>
                <div>
                  <strong dir="auto">{item.title ?? t("common.unavailable")}</strong>
                  {item.variant ? <p dir="auto">{item.variant}</p> : null}
                  <p>{t("recoveryDetail.quantity")}: {item.quantity ?? t("common.unavailable")}</p>
                </div>
                <div className="recovery-detail__basket-price">
                  <span>{t("recoveryDetail.unitPrice")}</span>
                  <strong>{money({ amount: item.unitPrice, currency: basket.currency })}</strong>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="recovery-detail__muted">{t("recoveryDetail.emptyBasket")}</p>}
    </details>
  );
}
