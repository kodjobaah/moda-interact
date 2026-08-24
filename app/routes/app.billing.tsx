import type { HeadersArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { Form } from "react-router";

import { authenticate } from "../shopify.server";

import { billingService } from "../services/billing/billing.service";

import { shopService } from "../services/shop/shop.service";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });

  const subscription = await billingService.getSubscription(shop.id);

  return {
    subscription: subscription
      ? {
          id: subscription.id,

          status: subscription.status,

          planHandle: subscription.planHandle,

          planName: subscription.plan?.name ?? subscription.planHandle,

          trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,

          currentPeriodEnd:
            subscription.currentPeriodEnd?.toISOString() ?? null,

          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
  };
}

export default function BillingRoute() {
  const { subscription } = useLoaderData<typeof loader>();

  return (
    <div
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: 24,
      }}
    >
      <h1>Billing</h1>

      {subscription ? (
        <>
          <p>
            Current plan: <strong>{subscription.planName}</strong>
          </p>

          <p>
            Status: <strong>{subscription.status}</strong>
          </p>

          {subscription.trialEndsAt && (
            <p>
              Trial ends:{" "}
              {new Date(subscription.trialEndsAt).toLocaleDateString()}
            </p>
          )}

          {subscription.currentPeriodEnd && (
            <p>
              Billing period ends:{" "}
              {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
            </p>
          )}

          {subscription.cancelAtPeriodEnd && (
            <p>
              This subscription will end at the end of the current billing
              period.
            </p>
          )}
        </>
      ) : (
        <>
          <h2>No active plan</h2>

          <p>Choose a plan to activate Moda Interact.</p>
        </>
      )}

      <Link to="/app/billing/select">
        {subscription ? "Change plan" : "Choose a plan"}
      </Link>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: HeadersArgs) => {
  return boundary.headers(headersArgs);
};
