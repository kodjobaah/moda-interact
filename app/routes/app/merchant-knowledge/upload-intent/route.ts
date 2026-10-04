import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import { MerchantKnowledgeError } from "@/services/merchant-knowledge/merchant-knowledge.server";
import { createMerchantKnowledgeUploadIntent } from "@/services/merchant-knowledge/upload.server";
import { recordMerchantKnowledgeUploadFailure } from "@/services/merchant-knowledge/merchant-knowledge-observability.server";

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
    recordMerchantKnowledgeUploadFailure({
      stage: "intent",
      shopId: shop.id,
      errorCode: "INVALID_INPUT",
      statusCode: 400,
    });
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }
  if (!validBody(body)) {
    recordMerchantKnowledgeUploadFailure({
      stage: "intent",
      shopId: shop.id,
      errorCode: "INVALID_INPUT",
      statusCode: 400,
    });
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }

  try {
    const intent = await createMerchantKnowledgeUploadIntent({
      shopId: shop.id,
      shopDomain: shop.domain,
      ...body,
    });
    return Response.json(intent, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MerchantKnowledgeError) {
      const status = error.code === "CONFLICT" ? 409 : error.code === "DENIED" ? 403 : 400;
      recordMerchantKnowledgeUploadFailure({
        stage: "intent",
        shopId: shop.id,
        purposeKey: body.purposeKey,
        dataFormatKey: body.dataFormatKey,
        sizeBytes: body.sizeBytes,
        contentType: body.contentType,
        statusCode: status,
        errorCode: error.code,
      });
      return Response.json({ ok: false, error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    recordMerchantKnowledgeUploadFailure({
      stage: "intent",
      shopId: shop.id,
      purposeKey: body.purposeKey,
      dataFormatKey: body.dataFormatKey,
      sizeBytes: body.sizeBytes,
      contentType: body.contentType,
      statusCode: 500,
      errorCode: "UNEXPECTED_ERROR",
      error,
    });
    throw error;
  }
}