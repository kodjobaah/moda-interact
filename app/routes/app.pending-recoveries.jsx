import { authenticate } from "../shopify.server";
import { readPendingRecoveries } from "../services/pending-recovery/pending-recovery-reader.server";
import { shopService } from "../services/shop/shop.service";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  const url = new URL(request.url);
  const pendingPage = Number.parseInt(url.searchParams.get("pendingPage") ?? "1", 10);
  const pendingRecoveries = await readPendingRecoveries({
    shopId: shop.id,
    shopDomain: shop.domain,
    page: pendingPage,
  });

  return {
    pendingRecoveries,
    refreshedAt: pendingRecoveries.available ? new Date().toISOString() : null,
  };
};