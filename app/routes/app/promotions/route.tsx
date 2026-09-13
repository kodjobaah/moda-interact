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
    await selectPromotionOffer(shop.id, campaignId);
    return { ok: true };
  } catch (error) {
    if (error instanceof PromotionSelectionError) {
      const messageKey = error.code === "ACTIVE_PROMOTION_ALREADY_SELECTED"
        ? "promotions.error.activeSelected"
        : error.code === "PROMOTION_NOT_ELIGIBLE"
          ? "promotions.error.notEligible"
          : "promotions.error.unavailable";
      return { ok: false, messageKey };
    }
    throw error;
  }
}

type PromotionOffer = Awaited<ReturnType<typeof loader>>["offers"][number];

export default function PromotionsRoute() {
  const { merchantUi, offers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const i18n = createMerchantI18n(merchantUi);
  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1>{i18n.t("promotions.page.title")}</h1>
      <p>{i18n.t("promotions.page.description")}</p>
      {actionData?.ok === true ? <p role="status">{i18n.t("promotions.success")}</p> : null}
      {actionData?.ok === false && actionData.messageKey ? <p role="alert">{i18n.t(actionData.messageKey)}</p> : null}
      {offers.length === 0 ? <p>{i18n.t("promotions.empty")}</p> : null}
      {offers.map((offer: PromotionOffer) => (
        <article key={offer.id}>
          <h3>{offer.name}</h3>
          {offer.merchantDescription ? <p>{offer.merchantDescription}</p> : null}
          <p>{i18n.t("promotions.credits", { quantity: offer.quantity })}</p>
          <p>{i18n.t("promotions.expires")}: {i18n.formatDate(offer.expiresAt)}</p>
          {offer.previouslyClaimed && !offer.exhausted ? <p>{i18n.t("promotions.remaining", { quantity: offer.remainingQuantity })}</p> : null}
          <p>{i18n.t(offer.exhausted ? "promotions.status.exhausted" : offer.currentlySelected ? "promotions.status.selected" : offer.previouslyClaimed ? "promotions.status.claimed" : "promotions.status.available")}</p>
          <Form method="post">
            <input type="hidden" name="campaignId" value={offer.id} />
            <button type="submit">{offer.previouslyClaimed ? i18n.t("promotions.action.reselect") : i18n.t("promotions.action.select")}</button>
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