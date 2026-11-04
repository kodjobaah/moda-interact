import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Form, Link, redirect, useLoaderData, useRouteError } from "react-router";
import { apiKey } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { enqueueBillingSubscriptionReconcileBestEffort } from "@/services/billing/billing-reconciliation.service";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";

export async function loader(/** @type {import("react-router").LoaderFunctionArgs} */ { request, context }) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { session } } = merchant;

  if (shop.status === "ACTIVE") throw redirect("/app");
  if (shop.status === "SUSPENDED") throw redirect("/app/merchant-support");
  if (shop.status !== "UNINSTALLED" || !shop.reinstallPendingAt) {
    throw redirect("/auth/login");
  }

  const subscription = await shopService.getReinstallSubscription(shop.id);
  return {
    apiKey,
    state: subscription?.nextReconcileAt ? "pending" : "stopped",
    nextReconcileAt: subscription?.nextReconcileAt?.toISOString() ?? null,
    merchantUi: merchantUiContext(shop, session),
  };
}

export async function action(/** @type {import("react-router").ActionFunctionArgs} */ { request, context }) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { session } } = merchant;
  const formData = await request.formData();
  if (formData.get("intent") !== "retry") throw redirect("/app/reinstalling");

  const admission = await shopService.retryReinstallReconciliation(shop.id);
  if (admission.kind === "SCHEDULED") {
    await enqueueBillingSubscriptionReconcileBestEffort(admission.schedule);
  } else if (admission.kind === "AUTHENTICATION_REQUIRED") {
    const query = new URLSearchParams({ shop: session.shop });
    throw redirect(`/auth/login?${query.toString()}`);
  }
  throw redirect("/app/reinstalling");
}

export default function ReinstallingRoute() {
  const { apiKey, state, merchantUi } = useLoaderData();
  const i18n = createMerchantI18n(merchantUi);
  const content = state === "pending" ? (
    <s-page heading={i18n.t("reinstalling.pendingTitle")}>
      <s-section>
        <p>{i18n.t("reinstalling.pendingDescription")}</p>
      </s-section>
    </s-page>
  ) : (
    <s-page heading={i18n.t("reinstalling.failedTitle")}>
      <s-section>
        <p>{i18n.t("reinstalling.failedDescription")}</p>
        <Form method="post">
          <input type="hidden" name="intent" value="retry" />
          <button type="submit">{i18n.t("reinstalling.retry")}</button>
        </Form>
        <Link to="/app/merchant-support">{i18n.t("reinstalling.contactSupport")}</Link>
      </s-section>
    </s-page>
  );

  return <AppProvider embedded apiKey={apiKey}>{content}</AppProvider>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (/** @type {import("react-router").HeadersArgs} */ headersArgs) => {
  return boundary.headers(headersArgs);
};