import { Form, Link, redirect, useLoaderData } from "react-router";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { enqueueBillingSubscriptionReconcileBestEffort } from "@/services/billing/billing-reconciliation.service";

export async function loader(/** @type {import("react-router").LoaderFunctionArgs} */ { request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });

  if (shop.status === "ACTIVE") throw redirect("/app");
  if (shop.status === "SUSPENDED") throw redirect("/app/merchant-support");
  if (shop.status !== "UNINSTALLED" || !shop.reinstallPendingAt) {
    throw redirect("/auth/login");
  }

  const subscription = await shopService.getReinstallSubscription(shop.id);
  return {
    state: subscription?.nextReconcileAt ? "pending" : "stopped",
    nextReconcileAt: subscription?.nextReconcileAt?.toISOString() ?? null,
  };
}

export async function action(/** @type {import("react-router").ActionFunctionArgs} */ { request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  const formData = await request.formData();
  if (formData.get("intent") !== "retry") throw redirect("/app/reinstalling");

  const reconciliation = await shopService.retryReinstallReconciliation(shop.id);
  if (reconciliation) {
    await enqueueBillingSubscriptionReconcileBestEffort(reconciliation);
  }
  throw redirect("/app/reinstalling");
}

export default function ReinstallingRoute() {
  const { state } = useLoaderData();
  if (state === "pending") {
    return (
      <s-page heading="Restoring your Moda Interact account">
        <s-section>
          <p>Moda Interact is restoring your Shopify subscription information.</p>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="We could not restore your Moda Interact account">
      <s-section>
        <p>Retry restoration or contact support if the problem continues.</p>
        <Form method="post">
          <input type="hidden" name="intent" value="retry" />
          <button type="submit">Retry</button>
        </Form>
        <Link to="/app/merchant-support">Contact support</Link>
      </s-section>
    </s-page>
  );
}