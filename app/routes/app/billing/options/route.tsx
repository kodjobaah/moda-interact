import SubscriptionChangePanel from "@/components/dashboard/SubscriptionChangePanel";
import { billingService } from "@/services/billing/billing.service";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { authenticate } from "@/shopify.server";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import { useLoaderData } from "react-router";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
    const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
    assertActiveShop(shop, { route: "/app/billing/options", capability: "manage-billing", redirectTo: "/app/merchant-support" });
    const state = await billingService.getMerchantShopifySubscriptionState(shop.id);
  const merchantUi = merchantUiContext(null, session)

  return {
    merchantUi,
    state,
    managePlansHref: "/app/billing/select",
  };
}
export default function BillingOptionsPage() {
  const { merchantUi, state, managePlansHref } = useLoaderData();
 const i18n = createMerchantI18n(merchantUi);

  const current = state.status === "ACTIVE_SUBSCRIPTION" ? {
    shopifyPlanHandle: state.subscription.planHandle,
    mappedModaPlanName: state.modaMapping?.name,
    price: state.subscription.price,
    interval: state.subscription.billingPeriod,
    cancelAtEndOfCycle: state.subscription.cancelAtEndOfCycle,
  } : null;
  const pending = state.status === "ACTIVE_SUBSCRIPTION" && state.subscription.pendingUpdate ? {
    shopifyPlanHandle: state.subscription.pendingUpdate.planHandle,
    mappedModaPlanName: state.pendingModaMapping?.name,
    price: state.subscription.pendingUpdate.price,
    interval: state.subscription.billingPeriod,
    effectiveAt: state.subscription.pendingUpdate.effectiveAt,
  } : null;

  return (
        <s-page heading={i18n.t("usage.billable")}>
          <Breadcrumbs
            current={i18n.t("billingCommerce.page.title")}
            merchantUi={merchantUi}
          />
        <SubscriptionChangePanel
          merchantUi={merchantUi}
          current={current}
          pending={pending}
          providerVerificationState={state.status}
          managePlansHref={managePlansHref}
          managePlansAvailable
        />
        </s-page>
  );
}
