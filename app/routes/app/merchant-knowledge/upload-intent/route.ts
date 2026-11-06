import { merchantKnowledgeActionFailure } from "@/services/merchant-knowledge/merchant-knowledge-http.server";
import type { ActionFunctionArgs } from "react-router";
import { settingsMutationAccess } from "@/services/feature-preferences/access.server";
import { createMerchantKnowledgeUploadIntent } from "@/services/merchant-knowledge/upload.server";

const FIELDS = ["purposeKey", "dataFormatKey", "originalFileName", "contentType", "sizeBytes"];
type IntentBody = Record<string, unknown> & {
  purposeKey: unknown;
  dataFormatKey: unknown;
  originalFileName: unknown;
  contentType: unknown;
  sizeBytes: unknown;
};

function validBody(value: unknown): value is IntentBody {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === FIELDS.length
    && Object.keys(value).every((key) => FIELDS.includes(key));
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
    const intent = await createMerchantKnowledgeUploadIntent({
      shopId: shop.id,
      ...body,
    });
    return Response.json(intent, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return merchantKnowledgeActionFailure(error, {shopId: shop.id, operation: "upload-intent"});
  }
}
