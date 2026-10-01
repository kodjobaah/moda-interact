import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import {
  MerchantKnowledgeError,
  reorderMerchantKnowledgeSources,
} from "@/services/merchant-knowledge/merchant-knowledge.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await settingsAccess(request);
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
    if (error instanceof MerchantKnowledgeError)
      return Response.json({ ok: false, error: error.code }, { status: error.code === "CONFLICT" ? 409 : error.code === "DENIED" ? 403 : 400 });
    throw error;
  }
}