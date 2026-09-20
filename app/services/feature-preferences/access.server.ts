import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { billingService } from "@/services/billing/billing.service";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "@/services/shop/merchant-route-access-policy";
export async function settingsAccess(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  assertActiveShop(shop, {
    route: "/app/recovery-settings",
    capability: "manage-settings",
    redirectTo: "/app/merchant-support",
  });
  const settings = await db.shopSettings.findUnique({
    where: { shopId: shop.id },
  });
  const state = resolveMerchantExperienceState({
    shop,
    settings,
    subscription: await billingService.getSubscription(shop.id),
  });
  if (!canAccessMerchantSurface(state, "RECOVERY_SETTINGS"))
    throw new Response(null, {
      status: 302,
      headers: {
        Location: getMerchantDeniedRedirect(state, "RECOVERY_SETTINGS"),
      },
    });
  return { shop, settings, session };
}
