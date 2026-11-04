import { merchantKnowledgeActionFailure } from "@/services/merchant-knowledge/merchant-knowledge-http.server";
import type { ActionFunctionArgs } from "react-router";
import { settingsMutationAccess } from "@/services/feature-preferences/access.server";
import {
  refreshWebPageSource,
} from "@/services/merchant-knowledge/merchant-knowledge.server";

export async function action({ request, context }: ActionFunctionArgs) {
  const { shop } = await settingsMutationAccess(request, context);
  const form = await request.formData();
  if ([...form.keys()].some((key) => key !== "sourceId" || form.getAll(key).length !== 1))
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  const sourceId = form.get("sourceId");
  if (typeof sourceId !== "string" || !sourceId.trim() || sourceId.length > 128)
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  try {
    await refreshWebPageSource({ shopId: shop.id, sourceId });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return merchantKnowledgeActionFailure(error, {shopId: shop.id, operation: "refresh"});
  }
}
