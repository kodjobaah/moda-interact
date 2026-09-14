import TopUpPurchasePanel from "@/components/dashboard/TopUpPurchasePanel";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { authenticate } from "@/shopify.server";
import { billingService } from "@/services/billing/billing.service";
import db from "@/db.server";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { randomUUID } from "node:crypto";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/options", capability: "purchase-recovery-credits", redirectTo: "/app/merchant-support" });
  const formData = await request.formData();
  const purchase = await billingService.requestRecoveryCreditPack(
    shop.id,
    String(formData.get("intent") ?? ""),
    String(formData.get("purchaseId") ?? ""),
  );
  return { purchasePending: purchase.status === "REQUESTED" };
}
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
    const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
    assertActiveShop(shop, { route: "/app/billing/options", capability: "manage-billing", redirectTo: "/app/merchant-support" });
    const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });



  const merchantUi = merchantUiContext(settings, session)


  const billing = await billingService.getMerchantBillingState(shop.id);

  return {
    merchantUi,
    topUpState: {
      configured: billing.configured,
      purchaseEligible: billing.purchaseEligible,
      unavailableReason: billing.unavailableReason,
      creditsPerPack: billing.creditsPerPack,
      purchasedCreditsAvailable: billing.purchasedRecoveryCredits.available,
      shopifyPackMeter: billing.shopifyPackMeter,
      latestPurchase: billing.latestPurchase,
    },
    purchaseId: randomUUID(),
  };
}

export default function BillingOptionsPage() {
  const {
    merchantUi,
    topUpState,
    purchaseId,
  } = useLoaderData();
  const fetcher = useFetcher();
 const i18n = createMerchantI18n(merchantUi);

  return (
        <s-page heading={i18n.t("usage.billable")}>
          <Breadcrumbs
            current={i18n.t("billingCommerce.page.title")}
            merchantUi={merchantUi}
          />
        <TopUpPurchasePanel merchantUi={merchantUi} topUpState={topUpState} onPurchaseTopUp={() => fetcher.submit({ intent: "BUY_RECOVERY_CREDIT_PACK", purchaseId }, { method: "post" })} />
        </s-page>

  );
}
