import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { recoveryCreditPurchaseManagementService } from "@/services/billing/recovery-credit-purchase-management.service";
import { merchantUiContext, createMerchantI18n } from "@/utils/merchant-i18n";
import db from "@/db.server";
import RecoveryCreditPurchaseManager from "@/components/dashboard/RecoveryCreditPurchaseManager";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/recovery-credit-purchases", capability: "read-billing", redirectTo: "/app/merchant-support" });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  const url = new URL(request.url);
  return {
    merchantUi: merchantUiContext(settings, session),
    page: await recoveryCreditPurchaseManagementService.listPurchaseHistory({
      shopId: shop.id,
      page: Number(url.searchParams.get("page") ?? "1"),
      pageSize: Number(url.searchParams.get("pageSize") ?? "20"),
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/recovery-credit-purchases", capability: "manage-billing", redirectTo: "/app/merchant-support" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent === "reactivate") {
    const purchaseId = String(formData.get("purchaseId") ?? "").trim();
    if (!purchaseId) return Response.json({ error: "purchaseId is required." }, { status: 400 });
    return Response.json(await recoveryCreditPurchaseManagementService.reactivateRefund({ shopId: shop.id, purchaseId }));
  }
  const requestId = String(formData.get("requestId") ?? "").trim();
  const purchaseIds = formData.getAll("purchaseId").map(String).map((id) => id.trim()).filter(Boolean);
  if (intent !== "request_refund" || !requestId || purchaseIds.length < 1 || purchaseIds.length > 20) {
    return Response.json({ error: "A bounded refund request is required." }, { status: 400 });
  }
  return Response.json(await recoveryCreditPurchaseManagementService.requestRefundBatch({
    shopId: shop.id,
    purchaseIds,
    requestId,
    shopifyUserId: session.onlineAccessInfo?.associated_user?.id?.toString() ?? null,
  }));
}

export default function RecoveryCreditPurchasesRoute() {
  const data = useLoaderData<typeof loader>();
  const i18n = createMerchantI18n(data.merchantUi);
  return <s-page heading={i18n.t("billingPurchases.title")}>
    <Breadcrumbs current={i18n.t("billingPurchases.title")} merchantUi={data.merchantUi} />
    <RecoveryCreditPurchaseManager merchantUi={data.merchantUi} page={data.page} />
  </s-page>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}