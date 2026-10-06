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
  const allowedKeys = new Set(["categoryId", "expectedPendingSelectionGeneration", "mappingId"]);
  if ([...form.keys()].some((key) => !allowedKeys.has(key)))
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });

  const categoryValues = form.getAll("categoryId");
  const generationValues = form.getAll("expectedPendingSelectionGeneration");
  const mappingValues = form.getAll("mappingId");
  if (categoryValues.length !== 1 || generationValues.length !== 1 || mappingValues.length > 256)
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });

  const categoryId = categoryValues[0];
  const generationValue = generationValues[0];
  const generation = typeof generationValue === "string" ? Number(generationValue) : NaN;
  const mappingIds = mappingValues.filter((value): value is string => typeof value === "string");
  if (
    typeof categoryId !== "string" || !categoryId.trim() || categoryId.length > 128 ||
    !Number.isSafeInteger(generation) || generation < 0 ||
    mappingIds.length !== mappingValues.length ||
    mappingIds.some((mappingId) => !mappingId.trim() || mappingId.length > 128) ||
    new Set(mappingIds).size !== mappingIds.length
  ) return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });

  try {
    const selection = await selectPendingStoreCategory({
      shopId: shop.id,
      categoryId,
      expectedPendingSelectionGeneration: generation,
      selectedMappingIds: mappingIds,
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