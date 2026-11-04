import { MerchantKnowledgeError, knowledgeFailureRetryable } from "./merchant-knowledge-error.server";
import { recordMerchantKnowledgeFailure } from "./merchant-knowledge-observability.server";
export function merchantKnowledgeActionFailure(error: unknown, context: { operation: string; shopId: string; sourceId?: string; assetId?: string }): Response {
  if (!(error instanceof MerchantKnowledgeError)) recordMerchantKnowledgeFailure({ ...context, error });
  const code = error instanceof MerchantKnowledgeError ? error.code : "UNAVAILABLE";
  const unavailable = code === "UNAVAILABLE";
  return Response.json({ ok: false, error: code, ...(unavailable ? { retryable: error instanceof MerchantKnowledgeError ? error.retryable === true : knowledgeFailureRetryable(error) } : {}) },
    { status: unavailable ? 503 : code === "CONFLICT" ? 409 : code === "DENIED" ? 403 : 400, headers: { "Cache-Control": "no-store" } });
}
