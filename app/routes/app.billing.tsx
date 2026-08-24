import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "react-router";

import {
  Form,
  useLoaderData,
} from "react-router";

import { authenticate } from "../shopify.server";

import {
  billingService,
} from "../services/billing/billing.service";

import {
  shopService,
} from "../services/shop/shop.service";


export async function loader({
  request,
}: LoaderFunctionArgs) {
  const {
    admin,
    session,
  } = await authenticate.admin(request);

  const shop =
    await shopService.resolveShopifyShop({
      admin,
      domain: session.shop,
    });

  const subscription =
    await billingService.getSubscription(
      shop.id,
    );

  return {
    subscription: subscription
      ? {
          id: subscription.id,

          status:
            subscription.status,

          planHandle:
            subscription.planHandle,

          planName:
            subscription.plan?.name ??
            subscription.planHandle,

          trialEndsAt:
            subscription.trialEndsAt
              ?.toISOString() ?? null,

          currentPeriodEnd:
            subscription.currentPeriodEnd
              ?.toISOString() ?? null,

          cancelAtPeriodEnd:
            subscription.cancelAtPeriodEnd,
        }
      : null,
  };
}


export async function action({
  request,
}: ActionFunctionArgs) {
  const {
    redirect,
    session,
  } = await authenticate.admin(request);

  const formData =
    await request.formData();

  const intent =
    formData.get("intent");

  if (intent !== "choose-plan") {
    throw new Response(
      "Unknown billing action",
      {
        status: 400,
      },
    );
  }

  const appHandle =
    process.env.SHOPIFY_APP_HANDLE;

  if (!appHandle) {
    throw new Error(
      "SHOPIFY_APP_HANDLE is not configured",
    );
  }

  const storeHandle =
    session.shop.replace(
      /\.myshopify\.com$/,
      "",
    );

  const pricingUrl =
    `https://admin.shopify.com/store/${storeHandle}` +
    `/charges/${appHandle}/pricing_plans`;

  return redirect(
    pricingUrl,
    {
      target: "_top",
    },
  );
}


export default function BillingRoute() {
  const {
    subscription,
  } = useLoaderData<typeof loader>();

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
            Current plan:{" "}
            <strong>
              {subscription.planName}
            </strong>
          </p>

          <p>
            Status:{" "}
            <strong>
              {subscription.status}
            </strong>
          </p>

          {subscription.trialEndsAt && (
            <p>
              Trial ends:{" "}
              {new Date(
                subscription.trialEndsAt,
              ).toLocaleDateString()}
            </p>
          )}

          {subscription.currentPeriodEnd && (
            <p>
              Billing period ends:{" "}
              {new Date(
                subscription.currentPeriodEnd,
              ).toLocaleDateString()}
            </p>
          )}

          {subscription.cancelAtPeriodEnd && (
            <p>
              This subscription will end
              at the end of the current
              billing period.
            </p>
          )}
        </>
      ) : (
        <>
          <h2>No active plan</h2>

          <p>
            Choose a plan to activate
            Moda Interact.
          </p>
        </>
      )}

      <Form method="post">
        <input
          type="hidden"
          name="intent"
          value="choose-plan"
        />

        <button type="submit">
          {subscription
            ? "Change plan"
            : "Choose a plan"}
        </button>
      </Form>
    </div>
  );
}