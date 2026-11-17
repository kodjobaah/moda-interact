import { canonicaliseLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "@/db.server";
import { authenticate } from "@/shopify.server";
import {
  logShopifyConsentFailure,
  prepareCartMarker,
  readCartConsentStatus,
  recordCartChoice,
  SHOPIFY_CONSENT_DISCLOSURE_TEXT,
  SHOPIFY_CONSENT_DISCLOSURE_VERSION,
  ShopifyConsentServiceError,
} from "@/services/shopify-consent/shopify-consent.server";

const APP_PROXY_SCOPE = "write_app_proxy";
const BASE_PATH = "/shopify/consent/";
const SIGNED_QUERY_KEYS = ["shop", "signature", "timestamp", "path_prefix", "logged_in_customer_id"] as const;
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

type AuthenticatedAppProxy = {
  shopId: string;
  shopDomain: string;
  shopifyCustomerId: string | null;
};

type AuthResult =
  | { context: AuthenticatedAppProxy }
  | { response: Response };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function failureResponse(code: string, status: number): Response {
  return jsonResponse({ error: code }, status);
}

function oneValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function validPathPrefix(value: string | null): value is string {
  if (!value || value.length > 256 || !value.startsWith("/apps/") ||
    value.includes("\\") || value.includes("?") || value.includes("#") || value.includes("//")) {
    return false;
  }
  const segments = value.split("/").slice(1);
  return segments[0] === "apps" &&
    segments.length >= 2 &&
    segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function authenticatedCustomerId(url: URL): string | null | undefined {
  const values = url.searchParams.getAll("logged_in_customer_id");
  if (values.length > 1) return undefined;
  const value = values[0];
  if (value === undefined || value === "") return null;
  return /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}

async function authenticateAppProxyRequest(request: Request): Promise<AuthResult> {
  const url = new URL(request.url);
  const signedShop = oneValue(url, "shop");
  const signature = oneValue(url, "signature");
  const timestamp = oneValue(url, "timestamp");
  const pathPrefix = oneValue(url, "path_prefix");
  const customerId = authenticatedCustomerId(url);
  if (
    !signedShop ||
    !signature ||
    !timestamp ||
    !/^[1-9]\d{8,11}$/.test(timestamp) ||
    !validPathPrefix(pathPrefix) ||
    customerId === undefined ||
    SIGNED_QUERY_KEYS.some(key => url.searchParams.getAll(key).length !== 1 &&
      !(key === "logged_in_customer_id" && url.searchParams.getAll(key).length === 0))
  ) {
    return { response: failureResponse("INVALID_APP_PROXY_REQUEST", 400) };
  }

  let context;
  try {
    context = await authenticate.public.appProxy(request);
  } catch (error) {
    logShopifyConsentFailure({
      operation: "app_proxy_authentication",
      stage: "signature_verification",
      error,
      reasonCode: "SHOPIFY_APP_PROXY_SIGNATURE_REJECTED",
    });
    if (error instanceof Response) {
      return { response: failureResponse("UNAUTHENTICATED_APP_PROXY_REQUEST", 401) };
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
  const grantedScopes = new Set((session.scope ?? "").split(",").map(scope => scope.trim()).filter(Boolean));
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

function sameShopOrigin(request: Request, shopDomain: string): boolean {
  return request.headers.get("Origin") === `https://${shopDomain}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let done = false;
  try {
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.done) continue;
      const { value } = result;
      totalBytes += value.byteLength;
      if (totalBytes > 8_192) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    const value: unknown = JSON.parse(body);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function serviceFailure(error: unknown, operation: "status_read" | "cart_prepare" | "cart_choice", shopId: string) {
  logShopifyConsentFailure({
    operation,
    stage: "consent_operation",
    error,
    shopId,
  });
  if (error instanceof ShopifyConsentServiceError) {
    const status = error.code === "REDIS_UNAVAILABLE" ? 503
      : error.code === "STALE_REVISION" || error.code === "ACTION_ID_CONFLICT" ||
        error.code === "RECORD_CONFLICT" || error.code === "MARKER_COLLISION" ? 409
        : error.code === "RECORD_CORRUPT" ? 503
          : 400;
    return failureResponse(error.code, status);
  }
  return failureResponse("CONSENT_UNAVAILABLE", 503);
}

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const auth = await authenticateAppProxyRequest(request);
  if ("response" in auth) return auth.response;
  const { shopId, shopifyCustomerId } = auth.context;
  if (request.method !== "GET") return failureResponse("METHOD_NOT_ALLOWED", 405);

  const url = new URL(request.url);
  if (url.pathname !== `${BASE_PATH}cart/status`) {
    return failureResponse("NOT_FOUND", 404);
  }
  const cartTokens = url.searchParams.getAll("cartToken");
  if (cartTokens.length !== 1 || !cartTokens[0]) {
    return failureResponse("INVALID_CART_TOKEN", 400);
  }
  try {
    const status = await readCartConsentStatus({
      shopId,
      cartToken: cartTokens[0],
      shopifyCustomerId,
    });
    return jsonResponse(status);
  } catch (error) {
    return serviceFailure(error, "status_read", shopId);
  }
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const auth = await authenticateAppProxyRequest(request);
  if ("response" in auth) return auth.response;
  const { shopId, shopDomain, shopifyCustomerId } = auth.context;
  if (request.method !== "POST") return failureResponse("METHOD_NOT_ALLOWED", 405);
  if (!sameShopOrigin(request, shopDomain)) {
    return failureResponse("ORIGIN_NOT_AUTHORIZED", 403);
  }

  const url = new URL(request.url);
  const body = await readJsonBody(request);
  if (!body) return failureResponse("INVALID_JSON_REQUEST", 400);

  if (url.pathname === `${BASE_PATH}cart/prepare`) {
    if (!hasOnlyKeys(body, ["cartToken"]) || typeof body.cartToken !== "string") {
      return failureResponse("INVALID_PREPARE_REQUEST", 400);
    }
    try {
      const prepared = await prepareCartMarker({ shopId, cartToken: body.cartToken });
      return jsonResponse(prepared);
    } catch (error) {
      return serviceFailure(error, "cart_prepare", shopId);
    }
  }

  if (url.pathname === `${BASE_PATH}cart/choice`) {
    const allowedKeys = [
      "cartToken",
      "marker",
      "actionId",
      "decision",
      "disclosureText",
      "disclosureVersion",
      "locale",
      "expectedRevision",
    ] as const;
    if (
      !hasOnlyKeys(body, allowedKeys) ||
      typeof body.cartToken !== "string" ||
      typeof body.marker !== "string" ||
      typeof body.actionId !== "string" ||
      (body.decision !== "GRANT" && body.decision !== "REVOKE") ||
      body.disclosureText !== SHOPIFY_CONSENT_DISCLOSURE_TEXT ||
      body.disclosureVersion !== SHOPIFY_CONSENT_DISCLOSURE_VERSION ||
      typeof body.locale !== "string" ||
      typeof body.expectedRevision !== "number"
    ) {
      return failureResponse("INVALID_CHOICE_REQUEST", 400);
    }
    let locale: string;
    try {
      locale = canonicaliseLanguageTag(body.locale);
    } catch {
      return failureResponse("INVALID_CHOICE_REQUEST", 400);
    }
    try {
      const result = await recordCartChoice({
        shopId,
        cartToken: body.cartToken,
        marker: body.marker,
        actionId: body.actionId,
        decision: body.decision,
        disclosureText: body.disclosureText,
        disclosureVersion: body.disclosureVersion,
        locale,
        expectedRevision: body.expectedRevision,
        shopifyCustomerIdAtAction: shopifyCustomerId,
      });
      return jsonResponse(result);
    } catch (error) {
      return serviceFailure(error, "cart_choice", shopId);
    }
  }

  return failureResponse("NOT_FOUND", 404);
}
