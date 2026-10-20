import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { requireRecoveryHistory } from "../recoveries/access.server";
import {
  RecoveryCommandError, changeRecoveryControl, admitRecoveryHumanSend,
  readRecoveryCommandStatus, type SendInput, type ControlInput,
} from "../../../services/recoveries/recovery-human-commands.server";

const logger = createLogger({ serviceName: "moda-interact", environment: process.env.NODE_ENV ?? "development" });
const response = (body: unknown, status = 200) => data(body, {
  status, headers: { "Cache-Control": "no-store" },
});

/**
 * Shopify App Bridge uses the public app origin even when a local proxy/tunnel
 * constructs Request.url with an internal HTTP origin. Shopify's verified
 * `SHOPIFY_APP_URL` is the trusted public origin for mutation CSRF checks;
 * never derive that trust from Host or X-Forwarded-* request headers.
 */
function configuredShopifyAppOrigin(): string | null {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) return null;
  try {
    const parsed = new URL(appUrl);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return parsed.origin;
  } catch { /* Fail closed for malformed configuration. */ }
  return null;
}

function denyOrigin(reasonCode: "ORIGIN_MISMATCH" | "CROSS_SITE_FETCH"): never {
  // Never log request headers, bearer tokens, URLs, or raw error objects.
  logger.warn("shopify.recovery.human_command_origin_denied", { reasonCode });
  throw new RecoveryCommandError("forbidden", 403);
}

function assertSameOrigin(request: Request) {
  const trustedOrigin = configuredShopifyAppOrigin();
  if (!trustedOrigin) {
    logger.error("shopify.recovery.human_command_origin_unavailable", { reasonCode: "APP_URL_UNAVAILABLE" });
    throw new RecoveryCommandError("origin_configuration_unavailable", 503);
  }
  if (request.headers.get("origin") !== trustedOrigin) return denyOrigin("ORIGIN_MISMATCH");
  if (request.headers.get("sec-fetch-site") === "cross-site") return denyOrigin("CROSS_SITE_FETCH");
}

async function requestObject(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RecoveryCommandError("invalid_request", 400);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 8192) throw new RecoveryCommandError("invalid_request", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new RecoveryCommandError("invalid_request", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        throw new RecoveryCommandError("invalid_request", 400);
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let parsed: unknown;
  try {
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch { throw new RecoveryCommandError("invalid_request", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RecoveryCommandError("invalid_request", 400);
  return parsed as Record<string, unknown>;
}
const exact = (object: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(object).sort().join("\u0000") === [...names].sort().join("\u0000");

function parseControl(body: Record<string, unknown>): ControlInput {
  if (!exact(body, ["targetMode", "expectedControlRevision"]) ||
      (body.targetMode !== "AI" && body.targetMode !== "HUMAN") ||
      !Number.isSafeInteger(body.expectedControlRevision)) throw new RecoveryCommandError("invalid_request", 400);
  return { targetMode: body.targetMode, expectedControlRevision: body.expectedControlRevision as number };
}
function parseSend(body: Record<string, unknown>): SendInput {
  const common = typeof body.idempotencyKey === "string" && Number.isSafeInteger(body.expectedControlRevision);
  if (!common) throw new RecoveryCommandError("invalid_request", 400);
  if (body.kind === "HUMAN_TEXT" && exact(body, ["kind", "idempotencyKey", "expectedControlRevision", "textBody"]) &&
      typeof body.textBody === "string") {
    return { kind: "HUMAN_TEXT", textBody: body.textBody, idempotencyKey: body.idempotencyKey as string,
      expectedControlRevision: body.expectedControlRevision as number };
  }
  if (body.kind === "RECOVERY_FOLLOW_UP_TEMPLATE" &&
      exact(body, ["kind", "idempotencyKey", "expectedControlRevision", "templateVariantId"]) &&
      typeof body.templateVariantId === "string") {
    return { kind: "RECOVERY_FOLLOW_UP_TEMPLATE", templateVariantId: body.templateVariantId,
      idempotencyKey: body.idempotencyKey as string,
      expectedControlRevision: body.expectedControlRevision as number };
  }
  throw new RecoveryCommandError("invalid_request", 400);
}

function handleFailure(error: unknown) {
  if (error instanceof RecoveryCommandError) return response({
    error: error.code,
    ...(error.currentControl ? { currentControl: error.currentControl } : {}),
  }, error.status);
  // Unique constraints and serializable conflicts must never fabricate a send.
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
  if (code === "P2002" || code === "P2034") return response({ error: "conflict_retry" }, 409);
  logger.error("shopify.recovery.human_command_failed", {
    reason: "internal_error", errorType: error instanceof Error ? error.name : "unknown",
  });
  return response({ error: "internal_error" }, 503);
}

export async function recoveryControlAction({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  const { shopId } = await requireRecoveryHistory(request);
  try {
    assertSameOrigin(request);
    const input = parseControl(await requestObject(request));
    return response(await changeRecoveryControl(shopId, params.recoveryId ?? "", input));
  } catch (error) { return handleFailure(error); }
}
export async function recoverySendAction({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  const { shopId } = await requireRecoveryHistory(request);
  try {
    assertSameOrigin(request);
    const input = parseSend(await requestObject(request));
    const result = await admitRecoveryHumanSend(shopId, params.recoveryId ?? "", input);
    return response({ schemaVersion: 1, ...result }, result.replay ? 200 : 202);
  } catch (error) { return handleFailure(error); }
}
export async function recoveryCommandStatusLoader({ request, params }: LoaderFunctionArgs) {
  const { shopId } = await requireRecoveryHistory(request);
  try {
    return response(await readRecoveryCommandStatus(shopId, params.recoveryId ?? "", params.commandId ?? ""));
  } catch (error) { return handleFailure(error); }
}
