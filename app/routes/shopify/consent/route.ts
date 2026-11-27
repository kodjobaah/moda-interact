import { ShopifyOfflineTokenError } from "@modainteract/moda-interact-shared/shopify/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "@/db.server";
import { authenticate } from "@/shopify.server";
import { ShopifySessionCoordinationRequiredError } from "@/services/shopify-session-storage.server";
import {
  ConsentReceiptServiceError,
  logShopifyConsentFailure,
  readReturningShopperConsentStatus,
  issueConsentReceipt,
  verifyConsentReceipt,
} from "@/services/shopify-consent/consent-receipt.server";
import {
  hasOnlyKeys,
  readBoundedJsonObject,
} from "@/services/shopify-consent/receipt-request.server";

const APP_PROXY_SCOPE = "write_app_proxy";
const BASE_PATH = "/shopify/consent/";
const SIGNED_QUERY_KEYS = [
  "shop",
  "signature",
  "timestamp",
  "path_prefix",
  "logged_in_customer_id",
] as const;
const MAX_PATH_PREFIX_LENGTH = 256;
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const APP_PROXY_CLOCK_SKEW_SECONDS = 300;

type AuthenticatedAppProxy = {
  shopId: string;
  shopDomain: string;
  shopifyCustomerId: string | null;
};

type AuthResult = { context: AuthenticatedAppProxy } | { response: Response };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: RESPONSE_HEADERS,
  });
}

function failureResponse(code: string, status: number): Response {
  return jsonResponse({ error: code }, status);
}

function oneValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function validPathPrefix(value: string | null): value is string {
  if (!value || value.length > MAX_PATH_PREFIX_LENGTH) return false;
  const match = /^\/(?:a|apps|community|tools)\/(.+)$/.exec(value);
  if (!match) return false;
  return match[1]
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(segment),
    );
}

function validTimestamp(value: string | null): value is string {
  if (!value || !/^[1-9]\d{8,11}$/.test(value)) return false;
  const timestamp = Number(value);
  return (
    Number.isSafeInteger(timestamp) &&
    Math.abs(Math.floor(Date.now() / 1000) - timestamp) <=
      APP_PROXY_CLOCK_SKEW_SECONDS
  );
}

function authenticatedCustomerId(url: URL): string | null | undefined {
  const values = url.searchParams.getAll("logged_in_customer_id");
  if (values.length > 1) return undefined;
  const value = values[0];
  if (value === undefined || value === "") return null;
  return /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}

function validHttpsOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null) return true;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === origin &&
      parsed.pathname === "/" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

async function authenticateAppProxyRequest(
  request: Request,
): Promise<AuthResult> {
  const url = new URL(request.url);
  const signedShop = oneValue(url, "shop");
  const signature = oneValue(url, "signature");
  const timestamp = oneValue(url, "timestamp");
  const pathPrefix = oneValue(url, "path_prefix");
  const customerId = authenticatedCustomerId(url);
  if (
    !signedShop ||
    !signature ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !validTimestamp(timestamp) ||
    !validPathPrefix(pathPrefix) ||
    customerId === undefined ||
    SIGNED_QUERY_KEYS.some(
      (key) =>
        url.searchParams.getAll(key).length !== 1 &&
        !(
          key === "logged_in_customer_id" &&
          url.searchParams.getAll(key).length === 0
        ),
    )
  ) {
    return { response: failureResponse("INVALID_APP_PROXY_REQUEST", 400) };
  }

  let context;
  try {
    context = await authenticate.public.appProxy(request);
  } catch (error) {
    const coordinationFailure =
      error instanceof ShopifySessionCoordinationRequiredError ||
      error instanceof ShopifyOfflineTokenError;
    const signatureRejected =
      error instanceof Response &&
      (error.status === 401 || error.status === 403);
    logShopifyConsentFailure({
      operation: "app_proxy_authentication",
      stage: coordinationFailure
        ? "offline_session_coordination"
        : signatureRejected
          ? "signature_verification"
          : "authentication",
      error,
      reasonCode: coordinationFailure
        ? "SHOPIFY_APP_PROXY_SESSION_UNAVAILABLE"
        : signatureRejected
          ? "SHOPIFY_APP_PROXY_SIGNATURE_REJECTED"
          : "SHOPIFY_APP_PROXY_AUTHENTICATION_FAILED",
      sensitiveValues: [signature],
    });
    if (coordinationFailure) {
      return {
        response: failureResponse("APP_PROXY_SESSION_UNAVAILABLE", 503),
      };
    }
    if (error instanceof Response) {
      return {
        response: failureResponse("UNAUTHENTICATED_APP_PROXY_REQUEST", 401),
      };
    }
    throw error;
  }

  const session = context.session;
  if (!session || session.shop !== signedShop) {
    return { response: failureResponse("SHOP_NOT_AUTHORIZED", 403) };
  }
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(session.shop)) {
    return { response: failureResponse("SHOP_NOT_AUTHORIZED", 403) };
  }
  const grantedScopes = new Set(
    (session.scope ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  if (!grantedScopes.has(APP_PROXY_SCOPE)) {
    return { response: failureResponse("APP_PROXY_SCOPE_REQUIRED", 403) };
  }

  let shop;
  try {
    shop = await db.shop.findUnique({
      where: { domain: session.shop },
      select: { id: true, domain: true, status: true },
    });
  } catch (error) {
    logShopifyConsentFailure({
      operation: "shop_resolution",
      stage: "database_lookup",
      error,
    });
    return { response: failureResponse("SHOP_UNAVAILABLE", 503) };
  }
  if (!shop || shop.status !== "ACTIVE" || shop.domain !== session.shop) {
    return { response: failureResponse("SHOP_NOT_AUTHORIZED", 403) };
  }
  return {
    context: {
      shopId: shop.id,
      shopDomain: shop.domain,
      shopifyCustomerId: customerId,
    },
  };
}

function serviceFailure(
  error: unknown,
  operation: "status_read" | "cart_receipt" | "cart_verify",
  shopId: string,
): Response {
  logShopifyConsentFailure({
    operation,
    stage: "consent_operation",
    error,
    shopId,
  });
  if (error instanceof ConsentReceiptServiceError) {
    return failureResponse(
      error.code,
      error.code === "CREDENTIAL_CONFIGURATION_UNAVAILABLE" ? 503 : 400,
    );
  }
  return failureResponse("CONSENT_UNAVAILABLE", 503);
}

export async function loader({
  request,
}: LoaderFunctionArgs): Promise<Response> {
  const auth = await authenticateAppProxyRequest(request);
  if ("response" in auth) return auth.response;
  if (request.method !== "GET")
    return failureResponse("METHOD_NOT_ALLOWED", 405);

  const url = new URL(request.url);
  if (url.pathname !== `${BASE_PATH}cart/status`) {
    return failureResponse("NOT_FOUND", 404);
  }
  try {
    const status = await readReturningShopperConsentStatus({
      shopId: auth.context.shopId,
      shopifyCustomerId: auth.context.shopifyCustomerId,
    });
    return jsonResponse(status);
  } catch (error) {
    return serviceFailure(error, "status_read", auth.context.shopId);
  }
}

export async function action({
  request,
}: ActionFunctionArgs): Promise<Response> {
  const auth = await authenticateAppProxyRequest(request);
  if ("response" in auth) return auth.response;
  if (request.method !== "POST")
    return failureResponse("METHOD_NOT_ALLOWED", 405);
  if (!validHttpsOrigin(request)) return failureResponse("INVALID_ORIGIN", 400);

  const url = new URL(request.url);
  if (url.pathname === `${BASE_PATH}cart/verify`) {
    const body = await readBoundedJsonObject(request);
    if (
      !body ||
      !hasOnlyKeys(body, ["cartToken", "receipt"]) ||
      typeof body.cartToken !== "string" ||
      typeof body.receipt !== "string"
    ) {
      return failureResponse("INVALID_RECEIPT_VERIFICATION_REQUEST", 400);
    }
    try {
      const claims = verifyConsentReceipt(body.receipt, {
        shopId: auth.context.shopId,
        kind: "c",
        token: body.cartToken,
        customerId: auth.context.shopifyCustomerId,
      });
      return jsonResponse({
        source: "verified_receipt",
        decision: claims.decision === "G" ? "GRANT" : "REVOKE",
      });
    } catch (error) {
      return serviceFailure(error, "cart_verify", auth.context.shopId);
    }
  }
  if (url.pathname !== `${BASE_PATH}cart/receipt`) {
    return failureResponse("NOT_FOUND", 404);
  }
  const body = await readBoundedJsonObject(request);
  if (
    !body ||
    !hasOnlyKeys(body, ["cartToken", "decision", "locale"]) ||
    typeof body.cartToken !== "string" ||
    (body.decision !== "GRANT" && body.decision !== "REVOKE") ||
    typeof body.locale !== "string"
  ) {
    return failureResponse("INVALID_RECEIPT_REQUEST", 400);
  }

  try {
    const receipt = issueConsentReceipt({
      shopId: auth.context.shopId,
      kind: "c",
      token: body.cartToken,
      decision: body.decision === "GRANT" ? "G" : "R",
      locale: body.locale,
      customerId: auth.context.shopifyCustomerId,
    });
    return jsonResponse({ receipt });
  } catch (error) {
    return serviceFailure(error, "cart_receipt", auth.context.shopId);
  }
}
