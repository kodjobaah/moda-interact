import {
  redirect,
  useLoaderData,
} from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

import Dashboard from "@/components/dashboard/Dashboard";
import Onboarding from "@/components/onboarding/Onboarding";

import {
  shopService,
} from "@/services/shop/shop.service";

import {
  billingService,
} from "@/services/billing/billing.service";

import db from "../db.server";


export const loader = async ({ request }) => {
  const {
    admin,
    session,
  } = await authenticate.admin(request);

  /*
   * Resolve Shopify's shop into our
   * internal tenant.
   */
  const shop =
    await shopService.resolveShopifyShop({
      admin,
      domain: session.shop,
    });


  /*
   * ShopSettings is now related using shopId,
   * rather than the Shopify domain string.
   */
  const settings =
    await db.shopSettings.findUnique({
      where: {
        shopId: shop.id,
      },
    });


  /*
   * Let the merchant complete onboarding first.
   */
  if (!settings) {
    return {
      settings: null,
      subscription: null,

      stats: {
        abandonedCheckouts: 0,
        recoveredCheckouts: 0,
        recoveredRevenue: 0,
        messagesSent: 0,
      },
    };
  }


  /*
   * Read local billing state.
   *
   * We don't need to call Shopify here.
   */
  const subscription =
    await billingService.getSubscription(
      shop.id,
    );

  if (!subscription) {
    throw redirect("/app/billing");
  }


  return {
    settings,

    subscription: {
      status: subscription.status,

      planHandle:
        subscription.planHandle,

      planName:
        subscription.plan?.name ??
        subscription.planHandle,
    },

    stats: {
      abandonedCheckouts: 42,
      recoveredCheckouts: 17,
      recoveredRevenue: 1284.5,
      messagesSent: 76,
    },
  };
};


export default function Index() {
  const {
    settings,
    stats,
  } = useLoaderData();

  if (!settings?.onboardingCompleted) {
    return <Onboarding />;
  }

  return (
    <Dashboard
      settings={settings}
      stats={stats}
    />
  );
}


export const headers = (/** @type {import("react-router").HeadersArgs} */ headersArgs) => {
  return boundary.headers(headersArgs);
};