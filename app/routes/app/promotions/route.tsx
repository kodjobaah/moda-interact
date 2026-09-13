import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import {
  getEligiblePromotionOffers,
  PromotionSelectionError,
  selectPromotionOffer,
} from "@/services/promotions/promotion.service";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import db from "@/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/promotions", capability: "read-promotions", redirectTo: "/app/merchant-support" });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  return {
    merchantUi: merchantUiContext(settings, session),
    offers: await getEligiblePromotionOffers(shop.id),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/promotions", capability: "select-promotions", redirectTo: "/app/merchant-support" });
  const formData = await request.formData();
  const campaignId = String(formData.get("campaignId") ?? "");
  try {
    return { ok: true, result: await selectPromotionOffer(shop.id, campaignId) };
  } catch (error) {
    if (error instanceof PromotionSelectionError) {
      return { ok: false, error: error.code };
    }
    throw error;
  }
}

export default function PromotionsRoute() {
  const { merchantUi, offers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const i18n = createMerchantI18n(merchantUi);
  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1>{i18n.t("billing.title")}</h1>
      <h2>{i18n.t("billing.viewPlans")}</h2>
      {offers.length === 0 ? <p>{i18n.t("billing.configurationUnavailableDescription")}</p> : null}
      {actionData?.ok === false ? <p role="alert">{i18n.t("billing.configurationUnavailableDescription")}</p> : null}
      {offers.map((offer) => (
        <article key={offer.id}>
          <h3>{offer.name}</h3>
          {offer.merchantDescription ? <p>{offer.merchantDescription}</p> : null}
          <p>{i18n.t("billing.recoveryCreditPackDescription", { quantity: offer.quantity })}</p>
          <p>{i18n.formatDate(offer.expiresAt)}</p>
          <p>{i18n.t("billing.purchasedRecoveryCredits", { granted: offer.quantity, committed: offer.quantity - offer.remainingQuantity, reserved: 0, available: offer.remainingQuantity })}</p>
          {offer.usable ? <p>{i18n.t("billing.status")}</p> : null}
          <Form method="post">
            <input type="hidden" name="campaignId" value={offer.id} />
            <button type="submit">{i18n.t("billing.changePlan")}</button>
          </Form>
        </article>
      ))}
    </main>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => boundary.headers(headersArgs);