/* global process */
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import {
  assertActiveShop,
  assertSupportShop,
} from "@/services/shop/shop-access-policy";
import { billingService } from "@/services/billing/billing.service";
import { resolveMerchantExperienceState } from "@/services/shop/merchant-route-access-policy";
import { readMerchantSupportMessages } from "@/services/merchant-support/merchant-support.service";
import { merchantUiContext } from "@/utils/merchant-i18n";
import MerchantNavigation from "@/components/dashboard/MerchantNavigation";
import db from "@/db.server";

/** @param {{ request: Request }} args */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  const pathname = new URL(request.url).pathname;
  const isMerchantSupport =
    pathname === "/app/merchant-support" ||
    pathname === "/app/merchant-support/";

  if (isMerchantSupport) {
    assertSupportShop(shop, {
      route: "/app/merchant-support",
      capability: "read-messages",
      redirectTo: "/auth/login",
    });
  } else {
    assertActiveShop(shop, {
      route: pathname,
      redirectTo: "/app/merchant-support",
    });
  }

  const support = await readMerchantSupportMessages({
    shopId: shop.id,
    page: 1,
    pageSize: 1,
  });
  const settings = await db.shopSettings.findUnique({
    where: { shopId: shop.id },
  });
  const subscription = await billingService.getSubscription(shop.id);
  const merchantExperienceState = resolveMerchantExperienceState({
    shop,
    settings,
    subscription,
  });

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    unreadMessages: support.unread,
    merchantUi: merchantUiContext(settings, session),
    merchantExperienceState,
  };
};

export default function App() {
  const { apiKey, unreadMessages, merchantUi, merchantExperienceState } =
    useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <div className="admin-brand-bar">
        <img
          className="brand-mark"
          src="/images/moda-interact-transparent-logo.jpg"
          alt="Moda Interact logo"
        />
      </div>
      <MerchantNavigation
        state={merchantExperienceState}
        unread={unreadMessages}
        merchantUi={merchantUi}
      />
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

/** @param {any} headersArgs */
export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
