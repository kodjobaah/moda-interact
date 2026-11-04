import { RouterContextProvider } from "react-router";
import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { readPendingRecoveries } from "@/services/pending-recovery/pending-recovery-reader.server";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { canAccessMerchantSurface, resolveMerchantExperienceState } from "@/services/shop/merchant-route-access-policy";

/** @param {{request: Request, context?: Readonly<import("react-router").RouterContextProvider>}} args */
export const loader = async ({ request, context = new RouterContextProvider() }) => {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop } = merchant;
  assertActiveShop(shop, { route: "/app/pending-recoveries", capability: "read-recoveries", redirectTo: "/app/merchant-support" });
  const subscription = await merchant.readSubscription();
  const merchantExperienceState = resolveMerchantExperienceState({ shop, subscription });
  if (!canAccessMerchantSurface(merchantExperienceState, "PENDING_RECOVERIES")) {
    return Response.json({
      pendingRecoveries: {
        available: false,
        page: 1,
        pageSize: 10,
        total: 0,
        totalPages: 0,
        items: [],
      },
      refreshedAt: null,
    });
  }

  const url = new URL(request.url);
  const pendingPage = Number.parseInt(url.searchParams.get("pendingPage") ?? "1", 10);
  const pendingRecoveries = await readPendingRecoveries({
    shopId: shop.id,
    shopDomain: shop.domain,
    page: pendingPage,
  });

  return Response.json({
    pendingRecoveries,
    refreshedAt: pendingRecoveries.available ? new Date().toISOString() : null,
  });
};