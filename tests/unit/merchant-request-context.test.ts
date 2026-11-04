import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import { merchantFixture, merchantRows } from "../helpers/merchant-request-fixtures";

const fixture = merchantFixture();
vi.mock("../../app/shopify.server", () => ({authenticate: {admin: fixture.authenticateAdmin}}));
vi.mock("../../app/db.server", () => ({default: {
  subscription: {findUnique: fixture.readSubscription},
  shopSettings: {findUnique: fixture.readSettings},
}}));
vi.mock("../../app/services/shop/shop.service", () => ({shopService: {
  getByDomain: fixture.lookup, resolveShopifyMerchantSnapshot: fixture.snapshot,
}, recordMerchantResolutionFailure: vi.fn()}));
const {getMerchantRequestContext, merchantPageContextMiddleware} = await import(
  "../../app/services/shop/merchant-request-context.server"
);
const request = (method = "GET") => new Request("https://app.test/app?shop=attacker.myshopify.com", {method});
const input = (method = "GET", context = new RouterContextProvider()) => ({request: request(method), context});
beforeEach(() => fixture.reset());

describe("merchant request context", () => {
  it("shares in-flight authentication, local identity and lazy scalar reads", async () => {
    const args = input();
    const [a, b] = await Promise.all([getMerchantRequestContext(args), getMerchantRequestContext(args)]);
    expect(a).toBe(b);
    expect(fixture.authenticateAdmin).toHaveBeenCalledTimes(1);
    expect(fixture.lookup).toHaveBeenCalledExactlyOnceWith(fixture.rows.shop.domain);
    expect(fixture.readSubscription).not.toHaveBeenCalled();
    expect(fixture.readSettings).not.toHaveBeenCalled();
    await Promise.all([a.readSubscription(), b.readSubscription(), a.readSettings(), b.readSettings()]);
    expect(fixture.readSubscription).toHaveBeenCalledTimes(1);
    expect(fixture.readSettings).toHaveBeenCalledTimes(1);
    expect(fixture.snapshot).not.toHaveBeenCalled();
    expect(a.authentication.redirect).toBe(fixture.redirect);
  });
  it.each(["GET", "HEAD"])("seeds %s page scalar rows with one profile refresh before loaders", async method => {
    const args = input(method);
    await merchantPageContextMiddleware({...args, params: {}, url: new URL(args.request.url), pattern: "/app"}, async () => {
      const [a, b] = await Promise.all([getMerchantRequestContext(args), getMerchantRequestContext(args)]);
      await a.readSubscription();
      await b.readSettings();
    });
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
    expect(fixture.lookup).not.toHaveBeenCalled();
    expect(fixture.readSubscription).not.toHaveBeenCalled();
    expect(fixture.readSettings).not.toHaveBeenCalled();
  });
  it("isolates HTTP contexts and tenants", async () => {
    const a = await getMerchantRequestContext(input());
    await getMerchantRequestContext(input());
    fixture.rows = merchantRows("second.myshopify.com");
    const b = await getMerchantRequestContext(input());
    expect(a.shop.id).not.toBe(b.shop.id);
    expect(fixture.authenticateAdmin).toHaveBeenCalledTimes(3);
    expect(fixture.lookup).toHaveBeenCalledTimes(3);
  });
  it("shares missing-row repair between concurrent lazy readers", async () => {
    fixture.readSubscription.mockResolvedValue(null);
    fixture.readSettings.mockResolvedValue(null);
    const merchant = await getMerchantRequestContext(input());
    const [subscription, settings] = await Promise.all([merchant.readSubscription(), merchant.readSettings()]);
    expect(subscription).toBe(fixture.rows.subscription);
    expect(settings).toBe(fixture.rows.settings);
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  });
  it("repairs missing Shop and seeds both rows", async () => {
    fixture.lookup.mockResolvedValue(null);
    const merchant = await getMerchantRequestContext(input());
    await merchant.readSubscription();
    await merchant.readSettings();
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
    expect(fixture.readSubscription).not.toHaveBeenCalled();
  });
  it("shares rejection and preserves SDK Response headers and identity", async () => {
    const response = new Response(null, {status: 302, headers: {Location: "/auth/login", "X-Shopify-API-Request-Failure-Reauthorize": "1"}});
    fixture.authenticateAdmin.mockRejectedValue(response);
    const args = input();
    const results = await Promise.allSettled([getMerchantRequestContext(args), getMerchantRequestContext(args)]);
    expect(results).toEqual([{status: "rejected", reason: response}, {status: "rejected", reason: response}]);
    expect(fixture.lookup).not.toHaveBeenCalled();
    expect(fixture.authenticateAdmin).toHaveBeenCalledTimes(1);
  });
  it("shares repair rejection without retrying or switching tenant", async () => {
    const error = new Error("profile-failure-marker");
    fixture.lookup.mockResolvedValue(null);
    fixture.snapshot.mockRejectedValue(error);
    const args = input();
    await expect(getMerchantRequestContext(args)).rejects.toBe(error);
    await expect(getMerchantRequestContext(args)).rejects.toBe(error);
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  });
  it("non-GET calls always obtain fresh local rows and read closures", async () => {
    const args = input("POST");
    const a = await getMerchantRequestContext(args);
    await a.readSettings();
    fixture.rows = {...fixture.rows, shop: {...fixture.rows.shop, status: "SUSPENDED"},
      settings: {...fixture.rows.settings, recoveryDelayMinutes: 90}};
    const b = await getMerchantRequestContext(args);
    expect(b.shop.status).toBe("SUSPENDED");
    expect((await b.readSettings())?.recoveryDelayMinutes).toBe(90);
    expect(a).not.toBe(b);
    expect(fixture.lookup).toHaveBeenCalledTimes(2);
    expect(fixture.readSettings).toHaveBeenCalledTimes(2);
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });
});


describe("real access helpers over the shared context", () => {
  it.each(["ACTIVE", "TRIALING"] as const)("preserves active-only settings admission for %s", async status => {
    const {settingsAccess} = await import("../../app/services/feature-preferences/access.server");
    fixture.rows.subscription.status = status;
    const args = input();
    const access = await settingsAccess(args.request, args.context);
    expect(access.merchant).toBe(await getMerchantRequestContext(args));
    expect(access.shop.id).toBe(fixture.rows.shop.id);
  });
  it.each(["FROZEN", "NO_CONTRACT", "UNMAPPED"] as const)("does not widen settings admission for %s", async status => {
    const {settingsAccess} = await import("../../app/services/feature-preferences/access.server");
    fixture.rows.subscription.status = status;
    const args = input();
    await expect(settingsAccess(args.request, args.context)).rejects.toBeInstanceOf(Response);
  });
  it.each(["SUSPENDED", "UNINSTALLED"] as const)("retains independent lifecycle denial for %s", async status => {
    const {settingsAccess} = await import("../../app/services/feature-preferences/access.server");
    const {requireRecoveryHistory} = await import("../../app/routes/app/recoveries/access.server");
    fixture.rows.shop.status = status;
    const args = input();
    await expect(settingsAccess(args.request, args.context)).rejects.toBeInstanceOf(Response);
    await expect(requireRecoveryHistory(args.request, args.context)).rejects.toBeInstanceOf(Response);
    expect(fixture.readSubscription).not.toHaveBeenCalled();
  });
  it("isolated optional helper fallback does not claim request sharing", async () => {
    const {settingsAccess} = await import("../../app/services/feature-preferences/access.server");
    const req = request();
    await settingsAccess(req);
    await settingsAccess(req);
    expect(fixture.authenticateAdmin).toHaveBeenCalledTimes(2);
    expect(fixture.lookup).toHaveBeenCalledTimes(2);
  });
});
