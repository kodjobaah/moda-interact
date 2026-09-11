import { authenticate } from "@/shopify.server";
import { readPendingRecoveries } from "@/services/pending-recovery/pending-recovery-reader.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { billingService } from "@/services/billing/billing.service";
import db from "@/db.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/pending-recoveries", capability: "read-recoveries", redirectTo: "/app/merchant-support" });
  const [settings, subscription] = await Promise.all([
    db.shopSettings.findUnique({ where: { shopId: shop.id } }),
    billingService.getSubscription(shop.id),
  ]);
  if (
    !settings?.onboardingCompleted ||
    !subscription ||
    !["ACTIVE", "TRIALING"].includes(subscription.status)
  ) {
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