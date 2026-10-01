import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import {
  MerchantKnowledgeError,
  refreshWebPageSource,
} from "@/services/merchant-knowledge/merchant-knowledge.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await settingsAccess(request);
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
    if (error instanceof MerchantKnowledgeError)
      return Response.json({ ok: false, error: error.code }, { status: error.code === "CONFLICT" ? 409 : error.code === "DENIED" ? 403 : 400 });
    throw error;
  }
}