import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { recoveryCreditPurchaseManagementService } from "@/services/billing/recovery-credit-purchase-management.service";

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/recovery-credits", capability: "read-billing", redirectTo: "/app/merchant-support" });
  const url = new URL(request.url);
  return Response.json(await recoveryCreditPurchaseManagementService.listPurchaseHistory({
    shopId: shop.id,
    page: Number(url.searchParams.get("page") ?? "1"),
    pageSize: Number(url.searchParams.get("pageSize") ?? "20"),
  }));
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/recovery-credits", capability: "manage-billing", redirectTo: "/app/merchant-support" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const requestId = String(formData.get("requestId") ?? "").trim();
  if (intent === "reactivate") {
    const purchaseId = String(formData.get("purchaseId") ?? "").trim();
    if (!purchaseId) return badRequest("purchaseId is required.");
    return Response.json(await recoveryCreditPurchaseManagementService.reactivateRefund({ shopId: shop.id, purchaseId }));
  }
  if (intent !== "request_refund" || !requestId) return badRequest("request_refund and requestId are required.");

  const purchaseIds = formData.getAll("purchaseId").map(String).map((id) => id.trim()).filter(Boolean);
  if (purchaseIds.length === 0 || purchaseIds.length > 20) return badRequest("Provide between 1 and 20 purchase IDs.");
  return Response.json(await recoveryCreditPurchaseManagementService.requestRefundBatch({
    shopId: shop.id,
    purchaseIds,
    requestId,
    shopifyUserId: session.onlineAccessInfo?.associated_user?.id?.toString() ?? null,
  }));
}