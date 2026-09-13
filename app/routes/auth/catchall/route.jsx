import { boundary } from "@shopify/shopify-app-react-router/server";
import { redirect } from "react-router";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { enqueueBillingSubscriptionReconcileBestEffort } from "@/services/billing/billing-reconciliation.service";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  if (admin && session) {
    const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
    if (shop.status === "UNINSTALLED") {
      const reconciliation = await shopService.beginReinstallReconciliation(shop.id);
      if (reconciliation) {
        await enqueueBillingSubscriptionReconcileBestEffort(reconciliation);
        throw redirect("/app/reinstalling");
      }
    }
  }

  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
