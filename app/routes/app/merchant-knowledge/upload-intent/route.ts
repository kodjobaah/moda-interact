import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import { MerchantKnowledgeError } from "@/services/merchant-knowledge/merchant-knowledge.server";
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

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await settingsAccess(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }
  if (!validBody(body)) return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });

  try {
    const intent = await createMerchantKnowledgeUploadIntent({ shopId: shop.id, ...body });
    return Response.json(intent, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MerchantKnowledgeError) {
      const status = error.code === "CONFLICT" ? 409 : error.code === "DENIED" ? 403 : 400;
      return Response.json({ ok: false, error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}