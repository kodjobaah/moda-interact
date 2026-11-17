import type { ActionFunctionArgs } from "react-router";
import db from "@/db.server";
import { apiKey, authenticate } from "@/shopify.server";
import {
  ConsentReceiptServiceError,
  issueConsentReceipt,
  logShopifyConsentFailure,
} from "@/services/shopify-consent/consent-receipt.server";
import {
  hasOnlyKeys,
  isObjectRecord,
  readBoundedJsonObject,
} from "@/services/shopify-consent/receipt-request.server";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const CUSTOMER_GID_PATTERN = /^gid:\/\/shopify\/Customer\/([1-9][0-9]{0,19})$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function failureResponse(code: string, status: number): Response {
  return jsonResponse({ error: code }, status);
}

function customerIdFromClaim(sessionToken: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(sessionToken, "sub")) return null;
  if (typeof sessionToken.sub !== "string") return undefined;
  return CUSTOMER_GID_PATTERN.exec(sessionToken.sub)?.[1];
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  let context;
  try {
    context = await authenticate.public.checkout(request);
  } catch (error) {
    logShopifyConsentFailure({
      operation: "checkout_receipt",
      stage: "session_authentication",
      error,
      sensitiveValues: [bearerToken(request)].filter((value): value is string => Boolean(value)),
      reasonCode: "SHOPIFY_CHECKOUT_SESSION_REJECTED",
    });
    if (error instanceof Response) {
      return request.method === "OPTIONS" ? error : failureResponse("UNAUTHENTICATED_CHECKOUT_REQUEST", 401);
    }
    throw error;
  }

  const cors = context.cors;
  const sessionToken: unknown = context.sessionToken;
  if (!isObjectRecord(sessionToken)) {
    return cors(failureResponse("INVALID_CHECKOUT_SESSION", 401));
  }

  const dest = sessionToken.dest;
  const customerId = customerIdFromClaim(sessionToken);
  const expiresAt = sessionToken.exp;
  if (
    sessionToken.aud !== apiKey ||
    typeof dest !== "string" ||
    !SHOP_DOMAIN_PATTERN.test(dest) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(Date.now() / 1000) ||
    customerId === undefined
  ) {
    return cors(failureResponse("INVALID_CHECKOUT_SESSION", 401));
  }

  let shop;
  try {
    shop = await db.shop.findUnique({
      where: { domain: dest },
      select: { id: true, domain: true, status: true },
    });
  } catch (error) {
    logShopifyConsentFailure({
      operation: "shop_resolution",
      stage: "database_lookup",
      error,
    });
    return cors(failureResponse("SHOP_UNAVAILABLE", 503));
  }
  if (!shop || shop.status !== "ACTIVE" || shop.domain !== dest) {
    return cors(failureResponse("SHOP_NOT_AUTHORIZED", 403));
  }

  if (request.method !== "POST") {
    return cors(failureResponse("METHOD_NOT_ALLOWED", 405));
  }
  const body = await readBoundedJsonObject(request);
  if (
    !body ||
    !hasOnlyKeys(body, ["checkoutToken", "decision", "locale"]) ||
    typeof body.checkoutToken !== "string" ||
    (body.decision !== "GRANT" && body.decision !== "REVOKE") ||
    typeof body.locale !== "string"
  ) {
    return cors(failureResponse("INVALID_RECEIPT_REQUEST", 400));
  }

  try {
    const receipt = issueConsentReceipt({
      shopId: shop.id,
      kind: "x",
      token: body.checkoutToken,
      decision: body.decision === "GRANT" ? "G" : "R",
      locale: body.locale,
      customerId,
    });
    return cors(jsonResponse({ receipt }));
  } catch (error) {
    logShopifyConsentFailure({
      operation: "checkout_receipt",
      stage: "consent_operation",
      error,
      shopId: shop.id,
    });
    if (error instanceof ConsentReceiptServiceError) {
      return cors(failureResponse(
        error.code,
        error.code === "SIGNING_KEY_UNAVAILABLE" ? 503 : 400,
      ));
    }
    return cors(failureResponse("CONSENT_UNAVAILABLE", 503));
  }
}

export function loader(): Response {
  return failureResponse("METHOD_NOT_ALLOWED", 405);
}
