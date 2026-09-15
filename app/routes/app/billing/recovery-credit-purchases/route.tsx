import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { RecoveryCreditPurchaseStatus } from "@prisma/client";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { recoveryCreditPurchaseManagementService } from "@/services/billing/recovery-credit-purchase-management.service";
import { billingService } from "@/services/billing/billing.service";
import { merchantUiContext, createMerchantI18n } from "@/utils/merchant-i18n";
import db from "@/db.server";
import RecoveryCreditPurchaseManager from "@/components/dashboard/RecoveryCreditPurchaseManager";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";
import { canAccessMerchantSurface, getMerchantDeniedRedirect, resolveMerchantExperienceState } from "@/services/shop/merchant-route-access-policy";

const PURCHASE_HISTORY_FILTERS = [
  "ACTIVE",
  "WITHDRAWN",
  "COMPLETED",
  "REFUNDED",
  "ALL",
] as const;

type PurchaseHistoryFilter = (typeof PURCHASE_HISTORY_FILTERS)[number];

const FILTER_TO_STATUS: Record<
  PurchaseHistoryFilter,
  RecoveryCreditPurchaseStatus | undefined
> = {
  ACTIVE: RecoveryCreditPurchaseStatus.ACTIVE,
  WITHDRAWN: RecoveryCreditPurchaseStatus.WITHDRAWN,
  COMPLETED: RecoveryCreditPurchaseStatus.COMPLETED,
  REFUNDED: RecoveryCreditPurchaseStatus.REFUNDED,
  ALL: undefined,
};

function resolvePurchaseHistoryFilter(value: string | null): PurchaseHistoryFilter {
  return PURCHASE_HISTORY_FILTERS.includes(value as PurchaseHistoryFilter)
    ? (value as PurchaseHistoryFilter)
    : "ACTIVE";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/recovery-credit-purchases", capability: "read-billing", redirectTo: "/app/merchant-support" });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  const subscription = await billingService.getSubscription(shop.id);
  const merchantExperienceState = resolveMerchantExperienceState({ shop, settings, subscription });
  if (!canAccessMerchantSurface(merchantExperienceState, "BILLING_PURCHASE_HISTORY")) throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(merchantExperienceState, "BILLING_PURCHASE_HISTORY") } });
  const url = new URL(request.url);
  const filter = resolvePurchaseHistoryFilter(url.searchParams.get("filter"));
  return {
    merchantUi: merchantUiContext(settings, session),
    filter,
    page: await recoveryCreditPurchaseManagementService.listPurchaseHistory({
      shopId: shop.id,
      page: Number(url.searchParams.get("page") ?? "1"),
      pageSize: Number(url.searchParams.get("pageSize") ?? "20"),
      status: FILTER_TO_STATUS[filter],
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/recovery-credit-purchases", capability: "manage-billing", redirectTo: "/app/merchant-support" });
  const [settings, subscription] = await Promise.all([
    db.shopSettings.findUnique({ where: { shopId: shop.id } }),
    billingService.getSubscription(shop.id),
  ]);
  const merchantExperienceState = resolveMerchantExperienceState({ shop, settings, subscription });
  if (!canAccessMerchantSurface(merchantExperienceState, "BILLING_PURCHASE_HISTORY")) throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(merchantExperienceState, "BILLING_PURCHASE_HISTORY") } });
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
    <Breadcrumbs items={[{ label: i18n.t("billingCommerce.page.title"), href: "/app/billing/options" }]} current={i18n.t("billingPurchases.title")} merchantUi={data.merchantUi} />
    <RecoveryCreditPurchaseManager merchantUi={data.merchantUi} page={data.page} filter={data.filter} />
  </s-page>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}