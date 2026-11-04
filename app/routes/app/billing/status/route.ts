import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import type { LoaderFunctionArgs } from "react-router";

import { billingService } from "@/services/billing/billing.service";
import {
  buildMerchantBillingSetupState,
  shouldShowMerchantBillingSetup,
} from "@/services/billing/merchant-billing-setup-state";
import { assertActiveShop } from "@/services/shop/shop-access-policy";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop } = merchant;
  assertActiveShop(shop, {
    route: "/app/billing/status",
    capability: "sync-billing",
    redirectTo: "/app/merchant-support",
  });

  const subscription = await billingService.getSubscriptionProjection(shop.id);

  const requiresSetupScreen = shouldShowMerchantBillingSetup(
    shop.onboardingCompleted,
    subscription,
  );

  return Response.json({
    requiresSetupScreen,
    setup: requiresSetupScreen
      ? buildMerchantBillingSetupState(subscription)
      : null,
  });
}
