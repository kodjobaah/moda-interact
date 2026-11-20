import { ShopifyOfflineTokenError } from "@modainteract/moda-interact-shared/shopify/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";

const appProxyAuthenticate = vi.fn();
const checkoutAuthenticate = vi.fn();
const findShop = vi.fn();
const readReturningShopperConsentStatus = vi.fn();
const issueConsentReceipt = vi.fn();
const verifyConsentReceipt = vi.fn();
const logShopifyConsentFailure = vi.fn();

vi.mock("../../../app/shopify.server", () => ({
  apiKey: "client-id",
  authenticate: {
    public: {
      appProxy: appProxyAuthenticate,
      checkout: checkoutAuthenticate,
    },
  },
}));
vi.mock("../../../app/db.server", () => ({
  default: { shop: { findUnique: findShop } },
}));
vi.mock("../../../app/services/shopify-consent/consent-receipt.server", () => ({
  ConsentReceiptServiceError: class ConsentReceiptServiceError extends Error {
    code = "CREDENTIAL_CONFIGURATION_UNAVAILABLE";
  },
  issueConsentReceipt,
  verifyConsentReceipt,
  logShopifyConsentFailure,
  readReturningShopperConsentStatus,
}));

const cartRoute = await import("../../../app/routes/shopify/consent/route");
const checkoutRoute = await import("../../../app/routes/shopify/checkout-receipt/route");

const SHOP_ID = "cmwexample000000000000001";
const PROXY_SIGNATURE = "a".repeat(64);
const APP_PROXY_PREFIX = "/apps/consent";

function routeArgs(request: Request, pattern: string) {
  return {
    request,
    params: {},
    context: new RouterContextProvider(),
    url: new URL(request.url),
    pattern,
  };
}

function proxyUrl(
  path: string,
  options: {
    timestamp?: number;
    pathPrefix?: string;
    customerId?: string;
    extraQuery?: string;
  } = {},
): string {
  const url = new URL(path, "https://app.example");
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const existingQuery = url.search.slice(1);
  const customer = options.customerId === undefined
    ? "logged_in_customer_id=123"
    : `logged_in_customer_id=${encodeURIComponent(options.customerId)}`;
  const query = [
    "shop=merchant.myshopify.com",
    `signature=${PROXY_SIGNATURE}`,
    `timestamp=${timestamp}`,
    `path_prefix=${encodeURIComponent(options.pathPrefix ?? APP_PROXY_PREFIX)}`,
    existingQuery,
    customer,
    options.extraQuery?.replace(/^&/, ""),
  ].filter(Boolean).join("&");
  return `${url.origin}${url.pathname}?${query}`;
}

function postRequest(path: string, body: unknown, init: {
  origin?: string;
  extraQuery?: string;
} = {}): Request {
  return new Request(proxyUrl(path, { extraQuery: init.extraQuery }), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(init.origin === undefined ? {} : { Origin: init.origin }),
    },
    body: JSON.stringify(body),
  });
}

function checkoutRequest(body: unknown): Request {
  return new Request("https://app.example/shopify/checkout/receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer checkout-session-token",
      Origin: "https://checkout.shopify.com",
    },
    body: JSON.stringify(body),
  });
}

function checkoutContext(overrides: Record<string, unknown> = {}) {
  const sessionToken: Record<string, unknown> = {
    aud: "client-id",
    dest: "merchant.myshopify.com",
    exp: Math.floor(Date.now() / 1000) + 60,
    sub: "gid://shopify/Customer/123",
    ...overrides,
  };
  if (Object.hasOwn(overrides, "sub") && overrides.sub === undefined) {
    delete sessionToken.sub;
  }
  return {
    sessionToken,
    cors: (response: Response) => {
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  appProxyAuthenticate.mockResolvedValue({
    session: { shop: "merchant.myshopify.com", scope: "read_customers,write_app_proxy" },
  });
  checkoutAuthenticate.mockResolvedValue(checkoutContext());
  findShop.mockResolvedValue({
    id: SHOP_ID,
    domain: "merchant.myshopify.com",
    status: "ACTIVE",
  });
  readReturningShopperConsentStatus.mockResolvedValue({
    checked: true,
    decision: "GRANTED",
    source: "postgresql",
  });
  issueConsentReceipt.mockReturnValue("signed-receipt");
  verifyConsentReceipt.mockReturnValue({ decision: "G" });
});

describe("Shopify consent App Proxy route", () => {
  it("issues a stateless cart receipt for a verified shop and signed customer", async () => {
    const request = postRequest(
      "/shopify/consent/cart/receipt",
      { cartToken: "cart-token?key=private", decision: "GRANT", locale: "en-GB" },
      { origin: "https://custom.store.example" },
    );
    const response = await cartRoute.action(routeArgs(request, "/shopify/consent/*"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ receipt: "signed-receipt" });
    expect(issueConsentReceipt).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      kind: "c",
      token: "cart-token?key=private",
      decision: "G",
      locale: "en-GB",
      customerId: "123",
    });
    expect(appProxyAuthenticate).toHaveBeenCalledOnce();
  });

  it.each([
    ["G", "GRANT", "123"],
    ["R", "REVOKE", "123"],
    ["G", "GRANT", null],
  ])("verifies the existing cart receipt for a signed customer context", async (signedDecision, decision, customerId) => {
    verifyConsentReceipt.mockReturnValueOnce({ decision: signedDecision });
    const request = new Request(proxyUrl("/shopify/consent/cart/verify", {
      customerId: customerId ?? "",
    }), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://custom.store.example",
      },
      body: JSON.stringify({
        cartToken: "current-cart-token?key=private",
        receipt: "current-cart-receipt",
      }),
    });
    const response = await cartRoute.action(routeArgs(request, "/shopify/consent/*"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      source: "verified_receipt",
      decision,
    });
    expect(verifyConsentReceipt).toHaveBeenCalledWith("current-cart-receipt", {
      shopId: SHOP_ID,
      kind: "c",
      token: "current-cart-token?key=private",
      customerId,
    });
    expect(issueConsentReceipt).not.toHaveBeenCalled();
  });

  it("rejects extra client-supplied verification identities and returns bounded verification errors", async () => {
    const forgedBody = await cartRoute.action(routeArgs(postRequest(
      "/shopify/consent/cart/verify",
      {
        cartToken: "cart-token",
        receipt: "opaque-receipt",
        shopId: "forged-shop",
        customerId: "456",
      },
    ), "/shopify/consent/*"));
    expect(forgedBody.status).toBe(400);
    expect(verifyConsentReceipt).not.toHaveBeenCalled();

    verifyConsentReceipt.mockImplementationOnce(() => {
      throw new Error("receipt verification failed");
    });
    const failed = await cartRoute.action(routeArgs(postRequest(
      "/shopify/consent/cart/verify",
      { cartToken: "private-cart-token", receipt: "private-receipt" },
    ), "/shopify/consent/*"));
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(body).not.toContain("private-cart-token");
    expect(body).not.toContain("private-receipt");
    expect(logShopifyConsentFailure).toHaveBeenCalledWith(expect.objectContaining({
      operation: "cart_verify",
      stage: "consent_operation",
      shopId: SHOP_ID,
    }));
  });

  it("allows custom HTTPS Origins and absent Origins without treating Origin as authentication", async () => {
    const customOrigin = await cartRoute.action(routeArgs(postRequest(
      "/shopify/consent/cart/receipt",
      { cartToken: "cart-token", decision: "REVOKE", locale: "en" },
      { origin: "https://store.custom-domain.example" },
    ), "/shopify/consent/*"));
    expect(customOrigin.status).toBe(200);

    const absentOrigin = await cartRoute.action(routeArgs(postRequest(
      "/shopify/consent/cart/receipt",
      { cartToken: "cart-token", decision: "REVOKE", locale: "en" },
    ), "/shopify/consent/*"));
    expect(absentOrigin.status).toBe(200);
  });

  it("reads returning-customer SQL status without a cart token and defaults guests unchecked", async () => {
    const returning = await cartRoute.loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status")),
      "/shopify/consent/*",
    ));
    expect(returning.status).toBe(200);
    expect(readReturningShopperConsentStatus).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      shopifyCustomerId: "123",
    });

    readReturningShopperConsentStatus.mockResolvedValueOnce({
      checked: false,
      decision: "NO_CUSTOMER",
      source: "postgresql",
    });
    const guest = await cartRoute.loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status", { customerId: "" })),
      "/shopify/consent/*",
    ));
    expect(guest.status).toBe(200);
    expect(readReturningShopperConsentStatus).toHaveBeenLastCalledWith({
      shopId: SHOP_ID,
      shopifyCustomerId: null,
    });
  });

  it("rejects stale timestamps, unapproved proxy prefixes, and duplicate signed identities", async () => {
    const stale = await cartRoute.loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status", {
        timestamp: Math.floor(Date.now() / 1000) - 301,
      })),
      "/shopify/consent/*",
    ));
    expect(stale.status).toBe(400);

    const future = await cartRoute.loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status", {
        timestamp: Math.floor(Date.now() / 1000) + 301,
      })),
      "/shopify/consent/*",
    ));
    expect(future.status).toBe(400);

    for (const pathPrefix of [
      "/admin/consent",
      "/apps",
      "/apps/../consent",
      "/community//consent",
      "/tools/consent?extra=true",
    ]) {
      const invalidPrefix = await cartRoute.loader(routeArgs(
        new Request(proxyUrl("/shopify/consent/cart/status", { pathPrefix })),
        "/shopify/consent/*",
      ));
      expect(invalidPrefix.status).toBe(400);
    }

    const missingPrefixUrl = new URL(proxyUrl("/shopify/consent/cart/status"));
    missingPrefixUrl.searchParams.delete("path_prefix");
    const missingPrefix = await cartRoute.loader(routeArgs(
      new Request(missingPrefixUrl),
      "/shopify/consent/*",
    ));
    expect(missingPrefix.status).toBe(400);

    const duplicateCustomer = await cartRoute.loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status", { extraQuery: "logged_in_customer_id=456" })),
      "/shopify/consent/*",
    ));
    expect(duplicateCustomer.status).toBe(400);
    expect(appProxyAuthenticate).not.toHaveBeenCalled();
    expect(readReturningShopperConsentStatus).not.toHaveBeenCalled();
  });

  it("accepts each supported signed App Proxy prefix and safe merchant subpath with an SDK-boundary mock", async () => {
    for (const pathPrefix of [
      "/a/cart-consent",
      "/apps/moda/consent",
      "/community/storefront/consent",
      "/tools/checkout/consent",
    ]) {
      const response = await cartRoute.loader(routeArgs(
        new Request(proxyUrl("/shopify/consent/cart/status", { pathPrefix })),
        "/shopify/consent/*",
      ));
      expect(response.status).toBe(200);
    }
    expect(appProxyAuthenticate).toHaveBeenCalledTimes(4);
  });

  it("returns unauthenticated when Shopify SDK signature verification rejects the proxy request", async () => {
    appProxyAuthenticate.mockRejectedValueOnce(new Response(null, { status: 401 }));
    const response = await cartRoute.loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status")),
      "/shopify/consent/*",
    ));
    expect(response.status).toBe(401);
    expect(readReturningShopperConsentStatus).not.toHaveBeenCalled();
  });

  it("reports App Proxy coordination failures without mislabelling them as invalid signatures", async () => {
    appProxyAuthenticate.mockRejectedValueOnce(new ShopifyOfflineTokenError("SESSION_MISSING"));
    const response = await cartRoute.loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status")),
      "/shopify/consent/*",
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "APP_PROXY_SESSION_UNAVAILABLE" });
    expect(readReturningShopperConsentStatus).not.toHaveBeenCalled();
    expect(logShopifyConsentFailure).toHaveBeenCalledWith(expect.objectContaining({
      operation: "app_proxy_authentication",
      stage: "offline_session_coordination",
      reasonCode: "SHOPIFY_APP_PROXY_SESSION_UNAVAILABLE",
    }));
  });

  it("rejects malformed or non-HTTPS Origin values and forged body identities", async () => {
    for (const origin of ["http://store.example", "not-an-origin", "https://store.example/path"]) {
      const response = await cartRoute.action(routeArgs(postRequest(
        "/shopify/consent/cart/receipt",
        { cartToken: "cart-token", decision: "GRANT", locale: "en" },
        { origin },
      ), "/shopify/consent/*"));
      expect(response.status).toBe(400);
    }

    const forgedBody = await cartRoute.action(routeArgs(postRequest(
      "/shopify/consent/cart/receipt",
      { cartToken: "cart-token", decision: "GRANT", locale: "en", shopId: "other-shop", customerId: "456" },
      { origin: "https://store.example" },
    ), "/shopify/consent/*"));
    expect(forgedBody.status).toBe(400);
    expect(issueConsentReceipt).not.toHaveBeenCalled();
  });

  it("requires proxy scope and bounded JSON bodies", async () => {
    appProxyAuthenticate.mockResolvedValueOnce({
      session: { shop: "merchant.myshopify.com", scope: "read_customers" },
    });
    const missingScope = await cartRoute.loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status")),
      "/shopify/consent/*",
    ));
    expect(missingScope.status).toBe(403);

    const oversized = await cartRoute.action(routeArgs(new Request(
      proxyUrl("/shopify/consent/cart/receipt"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cartToken: "x".repeat(8_200), decision: "GRANT", locale: "en" }),
      },
    ), "/shopify/consent/*"));
    expect(oversized.status).toBe(400);
    expect(issueConsentReceipt).not.toHaveBeenCalled();
  });
});

describe("Shopify checkout receipt route", () => {
  it("verifies the current checkout receipt before returning its decision", async () => {
    const response = await checkoutRoute.action(routeArgs(
      checkoutRequest({
        mode: "status",
        checkoutToken: "current-checkout-token",
        receipt: "signed-receipt",
      }),
      "/shopify/checkout/receipt",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      checked: true,
      decision: "G",
      source: "checkout",
    });
    expect(verifyConsentReceipt).toHaveBeenCalledWith("signed-receipt", {
      shopId: SHOP_ID,
      kind: "x",
      token: "current-checkout-token",
      customerId: "123",
    });
    expect(readReturningShopperConsentStatus).not.toHaveBeenCalled();
  });

  it("uses SQL status only when the checkout has no consent receipt", async () => {
    const response = await checkoutRoute.action(routeArgs(
      checkoutRequest({
        mode: "status",
        checkoutToken: "current-checkout-token",
        receipt: null,
      }),
      "/shopify/checkout/receipt",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      checked: true,
      decision: "GRANTED",
      source: "postgresql",
    });
    expect(readReturningShopperConsentStatus).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      shopifyCustomerId: "123",
    });
    expect(verifyConsentReceipt).not.toHaveBeenCalled();
  });

  it("rejects an empty or overlong checkout locator even when no receipt exists", async () => {
    for (const checkoutToken of ["", "x".repeat(513)]) {
      const response = await checkoutRoute.action(routeArgs(
        checkoutRequest({
          mode: "status",
          checkoutToken,
          receipt: null,
        }),
        "/shopify/checkout/receipt",
      ));
      expect(response.status).toBe(400);
    }
    expect(readReturningShopperConsentStatus).not.toHaveBeenCalled();
  });

  it("uses a verified checkout REVOKE as the current display state", async () => {
    verifyConsentReceipt.mockReturnValueOnce({ decision: "R" });
    const response = await checkoutRoute.action(routeArgs(
      checkoutRequest({
        mode: "status",
        checkoutToken: "current-checkout-token",
        receipt: "signed-revoke-receipt",
      }),
      "/shopify/checkout/receipt",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      checked: false,
      decision: "R",
      source: "checkout",
    });
  });

  it("fails closed when checkout receipt verification is unavailable", async () => {
    verifyConsentReceipt.mockImplementationOnce(() => {
      throw new Error("invalid receipt");
    });
    const response = await checkoutRoute.action(routeArgs(
      checkoutRequest({
        mode: "status",
        checkoutToken: "current-checkout-token",
        receipt: "copied-or-malformed-receipt",
      }),
      "/shopify/checkout/receipt",
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "CONSENT_UNAVAILABLE" });
    expect(readReturningShopperConsentStatus).not.toHaveBeenCalled();
  });

  it("authenticates checkout claims, verifies app audience, resolves shop and issues kind x", async () => {
    const request = checkoutRequest({
      checkoutToken: "current-checkout-token",
      decision: "GRANT",
      locale: "en-GB",
    });
    const response = await checkoutRoute.action(routeArgs(request, "/shopify/checkout/receipt"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({ receipt: "signed-receipt" });
    expect(issueConsentReceipt).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      kind: "x",
      token: "current-checkout-token",
      decision: "G",
      locale: "en-GB",
      customerId: "123",
    });
  });

  it("rejects wrong audience, expired sessions, malformed customer claims and missing checkout tokens", async () => {
    checkoutAuthenticate.mockResolvedValueOnce(checkoutContext({ aud: "other-client" }));
    const wrongAudience = await checkoutRoute.action(routeArgs(
      checkoutRequest({ checkoutToken: "token", decision: "GRANT", locale: "en" }),
      "/shopify/checkout/receipt",
    ));
    expect(wrongAudience.status).toBe(401);

    checkoutAuthenticate.mockResolvedValueOnce(checkoutContext({
      exp: Math.floor(Date.now() / 1000) - 1,
    }));
    const expired = await checkoutRoute.action(routeArgs(
      checkoutRequest({ checkoutToken: "token", decision: "GRANT", locale: "en" }),
      "/shopify/checkout/receipt",
    ));
    expect(expired.status).toBe(401);

    checkoutAuthenticate.mockResolvedValueOnce(checkoutContext({ sub: "not-a-customer-gid" }));
    const malformedCustomer = await checkoutRoute.action(routeArgs(
      checkoutRequest({ checkoutToken: "token", decision: "GRANT", locale: "en" }),
      "/shopify/checkout/receipt",
    ));
    expect(malformedCustomer.status).toBe(401);

    checkoutAuthenticate.mockResolvedValueOnce(checkoutContext({ sub: undefined }));
    const missingToken = await checkoutRoute.action(routeArgs(
      checkoutRequest({ decision: "GRANT", locale: "en" }),
      "/shopify/checkout/receipt",
    ));
    expect(missingToken.status).toBe(400);
    expect(issueConsentReceipt).not.toHaveBeenCalled();
  });

  it("does not turn SDK authentication failures into successful receipt responses", async () => {
    checkoutAuthenticate.mockRejectedValueOnce(new Response(null, { status: 401 }));
    const response = await checkoutRoute.action(routeArgs(
      checkoutRequest({ checkoutToken: "token", decision: "GRANT", locale: "en" }),
      "/shopify/checkout/receipt",
    ));
    expect(response.status).toBe(401);
    expect(logShopifyConsentFailure).toHaveBeenCalledWith(expect.objectContaining({
      operation: "checkout_receipt",
      stage: "session_authentication",
      sensitiveValues: ["checkout-session-token"],
    }));
    expect(issueConsentReceipt).not.toHaveBeenCalled();
  });
});
