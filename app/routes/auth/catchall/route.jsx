import { boundary } from "@shopify/shopify-app-react-router/server";
import { redirect } from "react-router";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { enqueueBillingSubscriptionReconcileBestEffort } from "@/services/billing/billing-reconciliation.service";

export const loader = async (/** @type {import("react-router").LoaderFunctionArgs} */ { request }) => {
  const { admin, session } = await authenticate.admin(request);

  if (admin && session) {
    // Authentication entry explicitly refreshes provider profile and provisioning.
    const shop = await shopService.resolveShopifyShop({ admin, sessionShop: session.shop });
    if (shop.status === "UNINSTALLED") {
      const admission = await shopService.beginReinstallReconciliation(shop.id);
      if (admission.kind === "SCHEDULED") {
        await enqueueBillingSubscriptionReconcileBestEffort(admission.schedule);
      } else if (admission.kind === "AUTHENTICATION_REQUIRED") {
        const query = new URLSearchParams({ shop: session.shop });
        throw redirect(`/auth/login?${query.toString()}`);
      }
      throw redirect("/app/reinstalling");
    }
  }

  return null;
};

export const headers = (/** @type {import("react-router").HeadersArgs} */ headersArgs) => {
  return boundary.headers(headersArgs);
};
