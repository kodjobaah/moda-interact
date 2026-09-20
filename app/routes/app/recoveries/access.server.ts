import { redirect } from "react-router";
import { authenticate } from "../../../shopify.server";
import { shopService } from "../../../services/shop/shop.service";
import { billingService } from "../../../services/billing/billing.service";
import db from "../../../db.server";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "../../../services/shop/merchant-route-access-policy";
import { merchantUiContext } from "../../../utils/merchant-i18n";
import type { EmbedContext } from "./recovery-list-state";

/** Every page/resource calls this guard independently before recovery reads. */
export async function requireRecoveryHistory(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  const url = new URL(request.url);
  const embed: EmbedContext = { shop: session.shop };
  const host = url.searchParams.get("host");
  if (host && /^[A-Za-z0-9+/_=-]{1,512}$/.test(host)) embed.host = host;
  if (url.searchParams.get("embedded") === "1") embed.embedded = "1";
  // Resolve lifecycle before recovery reads, even when this loader runs without its parent.
  // Inactive shops need no settings/subscription query to determine denial.
  const settings =
    shop.status === "ACTIVE"
      ? await db.shopSettings.findUnique({ where: { shopId: shop.id } })
      : null;
  const subscription =
    shop.status === "ACTIVE"
      ? await billingService.getSubscription(shop.id)
      : null;
  const state = resolveMerchantExperienceState({
    shop,
    settings,
    subscription,
  });
  if (!canAccessMerchantSurface(state, "RECOVERY_HISTORY")) {
    const destination = getMerchantDeniedRedirect(state, "RECOVERY_HISTORY");
    throw redirect(`${destination}?${new URLSearchParams(embed)}`);
  }
  return {
    shopId: shop.id,
    merchantUi: merchantUiContext(settings, session),
    embed,
  };
}
