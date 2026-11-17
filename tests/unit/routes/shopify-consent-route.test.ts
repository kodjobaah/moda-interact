import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";

const appProxyAuthenticate = vi.fn();
const findShop = vi.fn();
const prepareCartMarker = vi.fn();
const readCartConsentStatus = vi.fn();
const recordCartChoice = vi.fn();
const logShopifyConsentFailure = vi.fn();

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { public: { appProxy: appProxyAuthenticate } },
}));
vi.mock("../../../app/db.server", () => ({
  default: { shop: { findUnique: findShop } },
}));
vi.mock("../../../app/services/shopify-consent/shopify-consent.server", () => ({
  prepareCartMarker,
  readCartConsentStatus,
  recordCartChoice,
  logShopifyConsentFailure,
  SHOPIFY_CONSENT_DISCLOSURE_TEXT: "Send me WhatsApp shopping updates, reminders and offers.",
  SHOPIFY_CONSENT_DISCLOSURE_VERSION: "shopify-consent-v1",
  ShopifyConsentServiceError: class ShopifyConsentServiceError extends Error {
    code = "REDIS_UNAVAILABLE";
  },
}));

const { action, loader } = await import("../../../app/routes/shopify/consent/route");

function routeArgs(request: Request) {
  return {
    request,
    params: {},
    context: new RouterContextProvider(),
    url: new URL(request.url),
    pattern: "/shopify/consent/*",
  };
}

function proxyUrl(path: string, extra = "") {
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(path, "https://app.example");
  const existingQuery = url.search;
  url.search = "";
  return `${url.origin}${url.pathname}?shop=merchant.myshopify.com&signature=signed&timestamp=${timestamp}&path_prefix=%2Fapps%2Fmerchant-custom${existingQuery ? `&${existingQuery.slice(1)}` : ""}${extra}`;
}

function postRequest(path: string, body: unknown, init: { origin?: string; extraQuery?: string } = {}) {
  return new Request(proxyUrl(path, init.extraQuery), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(init.origin === undefined ? {} : { Origin: init.origin }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  appProxyAuthenticate.mockResolvedValue({
    session: { shop: "merchant.myshopify.com", scope: "read_customers,write_app_proxy" },
  });
  findShop.mockResolvedValue({
    id: "shop-internal-1",
    domain: "merchant.myshopify.com",
    status: "ACTIVE",
  });
  prepareCartMarker.mockResolvedValue({
    marker: `m1_${"A".repeat(43)}`,
    version: 1,
    ownerRevision: 0,
  });
  readCartConsentStatus.mockResolvedValue({
    checked: true,
    decision: "GRANTED",
    source: "postgresql",
    revision: null,
  });
  recordCartChoice.mockResolvedValue({ acknowledged: true, decision: "GRANT", revision: 1 });
});

describe("Shopify consent App Proxy route", () => {
  it("accepts a signed merchant-custom path prefix without trusting a client shop ID", async () => {
    const response = await action(routeArgs(postRequest(
        "/shopify/consent/cart/prepare",
        { cartToken: "cart-token" },
        { origin: "https://merchant.myshopify.com" },
      )));

    expect(response.status).toBe(200);
    expect(prepareCartMarker).toHaveBeenCalledWith({
      shopId: "shop-internal-1",
      cartToken: "cart-token",
    });
    expect(appProxyAuthenticate).toHaveBeenCalledOnce();
  });

  it("requires the exact shop origin and JSON content on browser POSTs", async () => {
    const missingOrigin = await action(routeArgs(
      postRequest("/shopify/consent/cart/prepare", { cartToken: "cart-token" }),
    ));
    expect(missingOrigin.status).toBe(403);
    expect(prepareCartMarker).not.toHaveBeenCalled();

    const crossShop = await action(routeArgs(postRequest(
        "/shopify/consent/cart/prepare",
        { cartToken: "cart-token" },
        { origin: "https://attacker.example" },
      )));
    expect(crossShop.status).toBe(403);
    expect(prepareCartMarker).not.toHaveBeenCalled();
  });

  it("requires the installed app-proxy scope and an authenticated active shop", async () => {
    appProxyAuthenticate.mockResolvedValueOnce({
      session: { shop: "merchant.myshopify.com", scope: "read_customers" },
    });
    const missingScope = await loader(routeArgs(
      new Request(proxyUrl("/shopify/consent/cart/status?cartToken=cart-token")),
    ));
    expect(missingScope.status).toBe(403);
    expect(findShop).not.toHaveBeenCalled();
    expect(readCartConsentStatus).not.toHaveBeenCalled();
  });

  it("derives returning-customer identity only from the signed proxy query", async () => {
    const response = await action(routeArgs(postRequest(
        "/shopify/consent/cart/choice",
        {
          cartToken: "cart-token",
          marker: `m1_${"A".repeat(43)}`,
          actionId: "action-1",
          decision: "GRANT",
          disclosureText: "Send me WhatsApp shopping updates, reminders and offers.",
          disclosureVersion: "shopify-consent-v1",
          locale: "en",
          expectedRevision: 0,
        },
        {
          origin: "https://merchant.myshopify.com",
          extraQuery: "&logged_in_customer_id=123",
        },
      )));

    expect(response.status).toBe(200);
    expect(recordCartChoice).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-internal-1",
      shopifyCustomerIdAtAction: "123",
    }));
    expect(recordCartChoice.mock.calls[0]?.[0]).not.toHaveProperty("customerId");
  });

  it("rejects client-supplied shop/customer authority and ambiguous signed parameters", async () => {
    const forgedBody = await action(routeArgs(postRequest(
        "/shopify/consent/cart/prepare",
        { cartToken: "cart-token", shopId: "other-shop", customerId: "456" },
        { origin: "https://merchant.myshopify.com" },
      )));
    expect(forgedBody.status).toBe(400);
    expect(prepareCartMarker).not.toHaveBeenCalled();

    const duplicateCustomerId = await loader(routeArgs(new Request(proxyUrl(
        "/shopify/consent/cart/status?cartToken=cart-token",
        "&logged_in_customer_id=123&logged_in_customer_id=456",
      ))));
    expect(duplicateCustomerId.status).toBe(400);
    expect(appProxyAuthenticate).toHaveBeenCalledOnce();
    expect(readCartConsentStatus).not.toHaveBeenCalled();
  });

  it("reads only the current cart and uses the signed returning-customer ID", async () => {
    const response = await loader(routeArgs(new Request(proxyUrl(
        "/shopify/consent/cart/status?cartToken=cart-token",
        "&logged_in_customer_id=123",
      ))));

    expect(response.status).toBe(200);
    expect(readCartConsentStatus).toHaveBeenCalledWith({
      shopId: "shop-internal-1",
      cartToken: "cart-token",
      shopifyCustomerId: "123",
    });
  });

  it("rejects oversized JSON without buffering it into memory", async () => {
    const response = await action(routeArgs(new Request(proxyUrl("/shopify/consent/cart/prepare"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://merchant.myshopify.com",
        },
        body: JSON.stringify({ cartToken: "x".repeat(8_200) }),
      })));

    expect(response.status).toBe(400);
    expect(prepareCartMarker).not.toHaveBeenCalled();
  });
});
