import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import { MerchantKnowledgeError } from "@/services/merchant-knowledge/merchant-knowledge.server";
import { reprocessMerchantKnowledgeUpload } from "@/services/merchant-knowledge/upload.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await settingsAccess(request);
  const form = await request.formData();
  if ([...form.keys()].some((key) => key !== "sourceId") || form.getAll("sourceId").length !== 1) {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }
  const sourceId = form.get("sourceId");
  if (typeof sourceId !== "string" || !sourceId || sourceId.length > 128) {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }
  try {
    await reprocessMerchantKnowledgeUpload({ shopId: shop.id, sourceId });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MerchantKnowledgeError) {
      const status = error.code === "CONFLICT" ? 409 : error.code === "DENIED" ? 403 : 400;
      return Response.json({ ok: false, error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}