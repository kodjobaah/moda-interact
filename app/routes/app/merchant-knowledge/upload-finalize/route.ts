import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import { MerchantKnowledgeError } from "@/services/merchant-knowledge/merchant-knowledge.server";
import { finalizeMerchantKnowledgeUpload } from "@/services/merchant-knowledge/upload.server";
import { recordMerchantKnowledgeUploadFailure } from "@/services/merchant-knowledge/merchant-knowledge-observability.server";

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

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await settingsAccess(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    recordMerchantKnowledgeUploadFailure({
      stage: "finalize",
      shopId: shop.id,
      errorCode: "INVALID_INPUT",
      statusCode: 400,
    });
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }
  if (!validBody(body)) {
    recordMerchantKnowledgeUploadFailure({
      stage: "finalize",
      shopId: shop.id,
      errorCode: "INVALID_INPUT",
      statusCode: 400,
    });
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }

  try {
    const result = await finalizeMerchantKnowledgeUpload({ shopId: shop.id, ...body });
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MerchantKnowledgeError) {
      const status = error.code === "CONFLICT" ? 409 : error.code === "DENIED" ? 403 : 400;
      recordMerchantKnowledgeUploadFailure({
        stage: "finalize",
        shopId: shop.id,
        assetId: body.assetId,
        purposeKey: body.purposeKey,
        sizeBytes: body.sizeBytes,
        contentType: body.contentType,
        statusCode: status,
        errorCode: error.code,
      });
      return Response.json({ ok: false, error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    recordMerchantKnowledgeUploadFailure({
      stage: "finalize",
      shopId: shop.id,
      assetId: body.assetId,
      purposeKey: body.purposeKey,
      sizeBytes: body.sizeBytes,
      contentType: body.contentType,
      statusCode: 500,
      errorCode: "UNEXPECTED_ERROR",
      error,
    });
    throw error;
  }
}