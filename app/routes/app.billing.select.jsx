import { useRouteError } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

export async function loader(/** @type {import("react-router").LoaderFunctionArgs} */ { request }) {
  const { redirect, session } = await authenticate.admin(request);

  const appHandle = process.env.SHOPIFY_APP_HANDLE;

  if (!appHandle) {
    throw new Error("SHOPIFY_APP_HANDLE is not configured");
  }

  const storeHandle = session.shop.replace(/\.myshopify\.com$/, "");

  const pricingUrl =
    `https://admin.shopify.com/store/${storeHandle}` +
    `/charges/${appHandle}/pricing_plans`;

  console.log("Redirecting to Shopify pricing:", pricingUrl);

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