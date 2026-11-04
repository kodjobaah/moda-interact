import { RouterContextProvider } from "react-router";
import { getMerchantRequestContext } from "../shop/merchant-request-context.server";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "@/services/shop/merchant-route-access-policy";
export async function settingsAccess(request: Request, context: Readonly<RouterContextProvider> = new RouterContextProvider()) {
  const merchant = await getMerchantRequestContext({request, context});
  const {shop, authentication: {session}} = merchant;
  assertActiveShop(shop, {
    route: "/app/recovery-settings",
    capability: "manage-settings",
    redirectTo: "/app/merchant-support",
  });
  const settings = await merchant.readSettings();
  const subscription = await merchant.readSubscription();
  const state = resolveMerchantExperienceState({
    shop,
    subscription: subscription && ["ACTIVE", "TRIALING"].includes(subscription.status) ? subscription : null,
  });
  if (!canAccessMerchantSurface(state, "RECOVERY_SETTINGS"))
    throw new Response(null, {
      status: 302,
      headers: {
        Location: getMerchantDeniedRedirect(state, "RECOVERY_SETTINGS"),
      },
    });
  return { shop, settings, session, merchant };
}
