import BillingPurchaseHub from "@/components/dashboard/BillingPurchaseHub";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import { useLoaderData } from "react-router";
import { mockBillingState } from "@/components/dashboard/billing-purchase.mock";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
    const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
    assertActiveShop(shop, { route: "/app/billing/options", capability: "manage-billing", redirectTo: "/app/merchant-support" });
    const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  
    
  
  const merchantUi = merchantUiContext(settings, session)
  

  const plans = [
  {
    id: "free",
    rank: 0,
    monthlyPriceMinor: 0,
    includedConversations: 5
  },
  {
    id: "starter",
    rank: 1,
    monthlyPriceMinor: 3500,
    includedConversations: 100
  },
  {
    id: "growth",
    rank: 2,
    monthlyPriceMinor: 7500,
    includedConversations: 250
  },
  {
    id: "scale",
    rank: 3,
    monthlyPriceMinor: 14900,
    includedConversations: 500
  }
]

  const topUpOffers = [
  {
    id: "starter-5-v1",
    planId: "starter",
    chargeAmountMinor: 500,
    currency: "GBP",
    creditsGranted: 15
  },
  {
    id: "starter-10-v1",
    planId: "starter",
    chargeAmountMinor: 1000,
    currency: "GBP",
    creditsGranted: 32
  }
]

  return {
    merchantUi,
    billing: {
      currentPlanId: "starter",
      monthlyUsed: 84,
      purchasedCreditsAvailable: 18
    },
    plans,
    topUpOffers,
  };
}

export default function BillingOptionsPage() {
  const {
    merchantUi,
    billing,
    plans,
    topUpOffers,
  } = useLoaderData();
 const i18n = createMerchantI18n(merchantUi);

  return (
        <s-page heading={i18n.t("usage.billable")}>
          <Breadcrumbs
            current={i18n.t("billingCommerce.page.title")}
            merchantUi={merchantUi}
          />
        <BillingPurchaseHub
  merchantUi={merchantUi}
  currentPlanId={mockBillingState.currentPlanId}
  monthlyUsed={mockBillingState.monthlyUsed}
  purchasedCreditsAvailable={
    mockBillingState.purchasedCreditsAvailable
  }
  plans={plans}
  topUpOffers={topUpOffers}
  onPurchaseTopUp={handleTopUp}
  onChangePlan={handlePlanChange}
/>
        </s-page>
  
  );
}

const handleTopUp = (offer) => {
  console.log("Top-up selected");
  console.log({
    offerId: offer.id,
    planId: offer.planId,
    chargeAmountMinor: offer.chargeAmountMinor,
    currency: offer.currency,
    creditsGranted: offer.creditsGranted,
  });
};

const handlePlanChange = (plan) => {
  console.log("Plan change selected");
  console.log({
    planId: plan.id,
    planName: plan.name,
    monthlyPriceMinor: plan.monthlyPriceMinor,
    currency: plan.currency,
    includedConversations: plan.includedConversations,
    rank: plan.rank,
  });
};
