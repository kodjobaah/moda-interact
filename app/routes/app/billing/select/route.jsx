import { useRouteError } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { billingService } from "@/services/billing/billing.service";

export async function loader(/** @type {import("react-router").LoaderFunctionArgs} */ { request }) {
  const { admin, redirect, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/select", capability: "manage-billing", redirectTo: "/app/merchant-support" });

  const capacity = await billingService.getMerchantRecoveryCapacityState(shop.id);
  if (capacity.availability === "CONTRACT_FROZEN") {
    throw new Response("Shopify billing is currently being restored.", { status: 403 });
  }

  const appHandle = process.env.SHOPIFY_APP_HANDLE;

  if (!appHandle) {
    throw new Error("SHOPIFY_APP_HANDLE is not configured");
  }

  const storeHandle = session.shop.replace(/\.myshopify\.com$/, "");

  const pricingUrl =
    `https://admin.shopify.com/store/${storeHandle}` +
    `/charges/${appHandle}/pricing_plans`;

  return redirect(pricingUrl, {
    target: "_top",
  });
}

export default function BillingSelectRoute() {
  return null;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (/** @type {import("react-router").HeadersArgs} */ headersArgs) => {
  return boundary.headers(headersArgs);
};