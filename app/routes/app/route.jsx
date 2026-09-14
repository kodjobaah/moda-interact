import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop, assertSupportShop } from "@/services/shop/shop-access-policy";
import { readMerchantSupportMessages } from "@/services/merchant-support/merchant-support.service";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import db from "@/db.server";

/** @param {{ request: Request }} args */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  const pathname = new URL(request.url).pathname;
  const isMerchantSupport = pathname === "/app/merchant-support" || pathname === "/app/merchant-support/";

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

  const support = await readMerchantSupportMessages({ shopId: shop.id, page: 1, pageSize: 1 });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", unreadMessages: support.unread, merchantUi: merchantUiContext(settings, session) };
};

export default function App() {
  const { apiKey, unreadMessages, merchantUi } = useLoaderData();
  const i18n = createMerchantI18n(merchantUi);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <div className="admin-brand-bar">
        <img className="brand-mark" src="/images/moda-interact-transparent-logo.jpg" alt="Moda Interact logo" />
      </div>
      {/* @ts-expect-error Shopify web component is not in the React JSX type map. */}
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/merchant-support">Messages{unreadMessages > 0 ? ` (${unreadMessages})` : ""}</s-link>
        <s-link href="/app/promotions">{i18n.t("promotions.nav")}</s-link>
      {/* @ts-expect-error Shopify web component is not in the React JSX type map. */}
      </s-app-nav>
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
