import { redirect, RouterContextProvider } from "react-router";
import { getMerchantRequestContext } from "../../../services/shop/merchant-request-context.server";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "../../../services/shop/merchant-route-access-policy";
import { merchantUiContext } from "../../../utils/merchant-i18n";
import type { EmbedContext } from "./recovery-list-state";

/** Every page/resource calls this guard independently before recovery reads. */
export async function requireRecoveryHistory(request: Request, context: Readonly<RouterContextProvider> = new RouterContextProvider()) {
  const merchant = await getMerchantRequestContext({request, context});
  const {shop, authentication: {session}} = merchant;
  const url = new URL(request.url);
  const embed: EmbedContext = { shop: session.shop };
  const host = url.searchParams.get("host");
  if (host && /^[A-Za-z0-9+/_=-]{1,512}$/.test(host)) embed.host = host;
  if (url.searchParams.get("embedded") === "1") embed.embedded = "1";
  // Resolve lifecycle before recovery reads, even when this loader runs without its parent.
  const subscription =
    shop.status === "ACTIVE"
      ? await merchant.readSubscription()
      : null;
  const state = resolveMerchantExperienceState({
    shop,
    subscription: subscription && ["ACTIVE", "TRIALING"].includes(subscription.status) ? subscription : null,
  });
  if (!canAccessMerchantSurface(state, "RECOVERY_HISTORY")) {
    const destination = getMerchantDeniedRedirect(state, "RECOVERY_HISTORY");
    throw redirect(`${destination}?${new URLSearchParams(embed)}`);
  }
  return {
    merchant,
    shopId: shop.id,
    merchantUi: merchantUiContext(shop, session),
    embed,
  };
}
