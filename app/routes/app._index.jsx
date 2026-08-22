import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

import Dashboard from "@/components/dashboard/Dashboard";
import Onboarding from "@/components/onboarding/Onboarding";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const settings = await db.shopSettings.findUnique({
    where: {
      shop: session.shop,
    },
  });

  return {
    settings,
    stats: {
    abandonedCheckouts: 42,
    recoveredCheckouts: 17,
    recoveredRevenue: 1284.5,
    messagesSent: 76,
  },
  };
};

export default function Index() {
  const { settings, stats } = useLoaderData();

  if (!settings) {
    return <sOnboarding />;
  }

  return <Dashboard settings={settings} stats={stats} />;
}


export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
