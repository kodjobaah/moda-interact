import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import { billingService } from "@/services/billing/billing.service";
import {
  buildMerchantBillingSetupState,
  shouldShowMerchantBillingSetup,
} from "@/services/billing/merchant-billing-setup-state";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  assertActiveShop(shop, {
    route: "/app/billing/status",
    capability: "sync-billing",
    redirectTo: "/app/merchant-support",
  });

  const [settings, subscription] = await Promise.all([
    db.shopSettings.findUnique({
      where: { shopId: shop.id },
      select: { onboardingCompleted: true },
    }),
    billingService.getSubscriptionProjection(shop.id),
  ]);

  const requiresSetupScreen = shouldShowMerchantBillingSetup(
    settings?.onboardingCompleted,
    subscription,
  );

  return Response.json({
    requiresSetupScreen,
    setup: requiresSetupScreen
      ? buildMerchantBillingSetupState(subscription)
      : null,
  });
}
