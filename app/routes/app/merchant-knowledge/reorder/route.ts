import { merchantKnowledgeActionFailure } from "@/services/merchant-knowledge/merchant-knowledge-http.server";
import type { ActionFunctionArgs } from "react-router";
import { settingsMutationAccess } from "@/services/feature-preferences/access.server";
import {
  reorderMerchantKnowledgeSources,
} from "@/services/merchant-knowledge/merchant-knowledge.server";

export async function action({ request, context }: ActionFunctionArgs) {
  const { shop } = await settingsMutationAccess(request, context);
  const form = await request.formData();
  if ([...form.keys()].some((key) => key !== "sourceIds" || form.getAll(key).length !== 1))
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  const raw = form.get("sourceIds");
  if (typeof raw !== "string" || raw.length > 131072)
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  let sourceIds: unknown;
  try {
    sourceIds = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }
  try {
    await reorderMerchantKnowledgeSources({ shopId: shop.id, sourceIds });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return merchantKnowledgeActionFailure(error, {shopId: shop.id, operation: "reorder"});
  }
}
