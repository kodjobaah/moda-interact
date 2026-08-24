import type {
  LoaderFunctionArgs,
} from "react-router";

import { authenticate } from "../shopify.server";

import {
  billingService,
} from "../services/billing/billing.service";
import { shopService } from "../services/shop/shop.service";


export async function loader({
  request,
}: LoaderFunctionArgs) {
  const {
    admin,
    redirect,
    session,
  } = await authenticate.admin(request);

  const url = new URL(request.url);

  const requestedPlanHandle =
    url.searchParams.get("plan_handle");

  if (!requestedPlanHandle) {
    throw new Response(
      "Missing plan_handle",
      { status: 400 },
    );
  }

  const shop =
    await shopService.resolveShopifyShop({
      admin,
      domain: session.shop,
    });

  const subscription =
    await billingService.syncSubscription(
      shop.id,
    );

  if (!subscription) {
    return redirect(
      "/app/billing?billing=inactive",
    );
  }

  if (
    requestedPlanHandle !==
    subscription.planHandle
  ) {
    console.warn(
      "Billing plan mismatch",
      {
        requestedPlanHandle,
        activePlanHandle:
          subscription.planHandle,
      },
    );
  }

  return redirect(
    "/app/billing?billing=success",
  );
}


export default function BillingCallback() {
  return null;
}