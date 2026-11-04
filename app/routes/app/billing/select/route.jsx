import process from "node:process";
import { useRouteError } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { canAccessMerchantSurface, getMerchantDeniedRedirect, resolveMerchantExperienceState } from "@/services/shop/merchant-route-access-policy";

export async function loader(/** @type {import("react-router").LoaderFunctionArgs} */ { request, context }) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { redirect, session } } = merchant;
  assertActiveShop(shop, { route: "/app/billing/select", capability: "manage-billing", redirectTo: "/app/merchant-support" });
  const scalar = await merchant.readSubscription();
  const subscription = scalar && ["ACTIVE", "TRIALING"].includes(scalar.status) ? scalar : null;
  const merchantExperienceState = resolveMerchantExperienceState({ shop, subscription });

  if (scalar?.status === "FROZEN") {
    throw new Response("Shopify billing is currently being restored.", { status: 403 });
  }

  if (!canAccessMerchantSurface(merchantExperienceState, "PLAN_SELECT")) throw redirect(getMerchantDeniedRedirect(merchantExperienceState, "PLAN_SELECT"));

  const appHandle = process.env.SHOPIFY_APP_HANDLE?.trim() || "moda-interact";

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