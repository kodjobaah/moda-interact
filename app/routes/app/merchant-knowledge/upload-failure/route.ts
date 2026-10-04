import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import {
  recordMerchantKnowledgeUploadFailure,
  type MerchantKnowledgeUploadFailureStage,
} from "@/services/merchant-knowledge/merchant-knowledge-observability.server";

const STAGES = new Set<MerchantKnowledgeUploadFailureStage>([
  "storage_put",
  "client_hash",
]);

const FIXED_ERROR_CODES = new Set([
  "STORAGE_NETWORK_ERROR",
  "HASH_FAILED",
]);

const FIELDS = [
  "stage",
  "assetId",
  "purposeKey",
  "dataFormatKey",
  "sizeBytes",
  "contentType",
  "statusCode",
  "errorCode",
];

type FailureBody = Record<string, unknown> & {
  stage: MerchantKnowledgeUploadFailureStage;
  errorCode: string;
};

function validErrorCode(value: unknown): value is string {
  return typeof value === "string" && (
    FIXED_ERROR_CODES.has(value)
    || /^STORAGE_HTTP_[1-5][0-9]{2}$/.test(value)
  );
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined
    || (typeof value === "string" && value.trim().length > 0 && value.length <= maxLength);
}

function validBody(value: unknown): value is FailureBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (!keys.every((key) => FIELDS.includes(key))) return false;
  if (!STAGES.has(body.stage as MerchantKnowledgeUploadFailureStage)) return false;
  if (!validErrorCode(body.errorCode)) return false;
  if (!optionalBoundedString(body.assetId, 128)) return false;
  if (!optionalBoundedString(body.purposeKey, 64)) return false;
  if (!optionalBoundedString(body.dataFormatKey, 64)) return false;
  if (!optionalBoundedString(body.contentType, 160)) return false;
  if (body.sizeBytes !== undefined && (!Number.isSafeInteger(body.sizeBytes) || (body.sizeBytes as number) < 0)) return false;
  if (body.statusCode !== undefined && (!Number.isInteger(body.statusCode) || (body.statusCode as number) < 100 || (body.statusCode as number) > 599)) return false;
  return true;
}

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await settingsAccess(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }

  if (!validBody(body)) {
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
  }

  recordMerchantKnowledgeUploadFailure({
    stage: body.stage,
    shopId: shop.id,
    assetId: body.assetId,
    purposeKey: body.purposeKey,
    dataFormatKey: body.dataFormatKey,
    sizeBytes: body.sizeBytes,
    contentType: body.contentType,
    statusCode: body.statusCode,
    errorCode: body.errorCode,
  });

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
