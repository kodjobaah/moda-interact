import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import {
  selectPendingStoreCategory,
  StoreCategorySelectionError,
} from "@/services/store-profile/store-category-selection.server";

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, {
    route: "/app/store-profile/category",
    redirectTo: "/app/merchant-support",
  });

  const form = await request.formData();
  if ([...form.keys()].some((key) =>
    !["categoryId", "expectedPendingSelectionGeneration"].includes(key) ||
    form.getAll(key).length !== 1,
  )) return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });

  const categoryId = form.get("categoryId");
  const generationValue = form.get("expectedPendingSelectionGeneration");
  const generation = typeof generationValue === "string" ? Number(generationValue) : NaN;
  if (
    typeof categoryId !== "string" || !categoryId.trim() || categoryId.length > 128 ||
    !Number.isSafeInteger(generation) || generation < 0
  ) return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });

  try {
    const selection = await selectPendingStoreCategory({
      shopId: shop.id,
      categoryId,
      expectedPendingSelectionGeneration: generation,
    });
    return Response.json({ ok: true, ...selection }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof StoreCategorySelectionError)
      return Response.json(
        { ok: false, error: error.code },
        { status: error.code === "CONFLICT" ? 409 : 400 },
      );
    throw error;
  }
}