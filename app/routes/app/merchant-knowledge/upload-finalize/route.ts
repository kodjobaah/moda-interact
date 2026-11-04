import { merchantKnowledgeActionFailure } from "@/services/merchant-knowledge/merchant-knowledge-http.server";
import type { ActionFunctionArgs } from "react-router";
import { settingsMutationAccess } from "@/services/feature-preferences/access.server";
import { finalizeMerchantKnowledgeUpload } from "@/services/merchant-knowledge/upload.server";

const FIELDS = ["assetId", "purposeKey", "name", "languageTag", "sizeBytes", "sha256", "contentType", "sourceId"];
type FinalizeBody = Record<string, unknown> & {
  assetId: unknown;
  purposeKey: unknown;
  name: unknown;
  languageTag: unknown;
  sizeBytes: unknown;
  sha256: unknown;
  contentType: unknown;
};

function validBody(value: unknown): value is FinalizeBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => FIELDS.includes(key))
    && ["assetId", "purposeKey", "name", "languageTag", "sizeBytes", "sha256", "contentType"].every((key) => keys.includes(key));
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { shop } = await settingsMutationAccess(request, context);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }
  if (!validBody(body)) {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }

  try {
    const result = await finalizeMerchantKnowledgeUpload({ shopId: shop.id, ...body });
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return merchantKnowledgeActionFailure(error, {shopId: shop.id, operation: "upload-finalize"});
  }
}
