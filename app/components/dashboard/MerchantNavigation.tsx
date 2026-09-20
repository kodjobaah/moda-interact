import { createElement } from "react";
import {
  getMerchantNavigation,
  type MerchantExperienceState,
} from "../../services/shop/merchant-route-access-policy";
import { createMerchantI18n } from "../../utils/merchant-i18n";
export default function MerchantNavigation({
  state,
  unread,
  merchantUi,
}: {
  state: MerchantExperienceState;
  unread: number;
  merchantUi: { locale: string; timeZone: string; fallbackLocale?: string };
}) {
  const i18n = createMerchantI18n(merchantUi);
  const keys = {
    home: state === "ONBOARDING" ? "merchantNav.home" : "merchantNav.overview",
    recoveries: "recoveries.title",
    billing: "merchantNav.billing",
    promotions: "promotions.nav",
    support: "merchantNav.support",
    recoverySettings: "recoverySettings.nav",
  };
  return createElement(
    "s-app-nav",
    null,
    getMerchantNavigation(state).map((item) => (
      <s-link key={item.id} href={item.href}>
        {i18n.t(keys[item.id])}
        {item.id === "support" && unread > 0
          ? ` (${i18n.formatNumber(unread)})`
          : ""}
      </s-link>
    )),
  );
}
