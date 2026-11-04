import {beforeEach, describe, expect, it, vi} from "vitest";
import {createMemoryRouter, createStaticHandler, RouterContextProvider, type LoaderFunctionArgs} from "react-router";
import {merchantFixture} from "../helpers/merchant-request-fixtures";

const fixture = merchantFixture();
vi.mock("../../app/shopify.server", () => ({authenticate: {admin: fixture.authenticateAdmin}, apiKey: "public-api-key"}));
vi.mock("../../app/db.server", () => ({default: {
  shop: {findUnique: fixture.lookup},
  subscription: {findUnique: fixture.readSubscription}, shopSettings: {findUnique: fixture.readSettings},
}}));
const commercialProjection = vi.fn(async () => ({subscription: fixture.rows.subscription, capacity: null}));
vi.mock("../../app/services/billing/billing.service", () => ({billingService: {
  readMerchantHomeBillingPresentation: commercialProjection,
}}));
vi.mock("../../app/services/merchant-support/merchant-support.service", () => ({
  readMerchantSupportUnreadCount: async () => 0,
}));
vi.mock("../../app/services/pending-recovery/pending-recovery-reader.server", () => ({
  readPendingRecoveries: async () => ({available: false, items: []}),
}));
vi.mock("../../app/services/merchant-pricing/merchant-pricing.server", () => ({
  readActiveMerchantPricingCatalogue: async () => [],
}));
vi.mock("../../app/routes/app/home/overview.server", () => ({
  loadOverviewPerformance: async () => ({}), overviewEmbed: () => ({}),
}));
vi.mock("../../app/services/store-profile/store-category.server", () => ({
  listSelectableStoreCategories: async () => [], loadStoreProfile: async () => ({activeCategory: {}}),
}));
vi.mock("../../app/services/store-profile/shopify-taxonomy-suggestion.server", () => ({
  suggestStoreCategory: async () => null,
}));
vi.mock("../../app/services/feature-preferences/feature-preferences.server", () => ({
  loadFeaturePreferences: async () => ({revision: "fixture", features: [], denied: false}),
  saveFeaturePreferences: vi.fn(), PreferenceError: class extends Error {},
}));
vi.mock("../../app/services/recovery-policy/recovery-policy.server", () => ({
  loadRecoveryPolicySnapshot: async () => ({recoveryDelayMinutes: 30}),
  saveMerchantRecoveryPolicy: vi.fn(), RecoveryPolicyValidationError: class extends Error {},
}));
vi.mock("../../app/services/merchant-knowledge/merchant-knowledge.server", () => ({
  loadMerchantKnowledge: async () => ({sources: []}),
}));
const readRecoveryPage = vi.fn(async () => ({
  items: [{id: "owned-recovery"}], previousCursor: null, nextCursor: null,
}));
vi.mock("../../app/services/recoveries/recovery-readers.server", () => ({readRecoveryPage}));
const {getMerchantRequestContext, merchantPageContextMiddleware} = await import(
  "../../app/services/shop/merchant-request-context.server"
);
const methods: string[] = [];
async function loader({request, context}: LoaderFunctionArgs) {
  methods.push(request.method);
  const merchant = await getMerchantRequestContext({request, context: context as RouterContextProvider});
  return {status: merchant.shop.status, delay: (await merchant.readSettings())?.recoveryDelayMinutes};
}
async function action(args: LoaderFunctionArgs) {
  await loader(args);
  fixture.rows = {...fixture.rows, shop: {...fixture.rows.shop, status: "SUSPENDED"},
    settings: {...fixture.rows.settings, recoveryDelayMinutes: 75}};
  return {saved: true};
}
beforeEach(() => {
  fixture.reset(); methods.length = 0;
  fixture.graphql.mockImplementation(async () => Response.json({data: {
    shop: {shopifyShopId: fixture.rows.shop.shopifyShopId, myshopifyDomain: fixture.rows.shop.domain,
      ianaTimezone: "UTC", shopAddress: {countryCodeV2: "GB"}},
    shopLocales: [{locale: "en", primary: true, published: true}],
  }}));
});

describe("installed React Router middleware (synthetic Shopify SDK and Prisma ports)", () => {
  it("runs parent middleware before parallel matched loaders", async () => {
    const handler = createStaticHandler([{
      id: "parent", path: "/app", middleware: [merchantPageContextMiddleware], loader,
      children: [{id: "child", path: "child", loader}],
    }]);
    const response = await handler.query(new Request("https://app.test/app/child"), {
      requestContext: new RouterContextProvider(),
      generateMiddlewareResponse: async query => Response.json(await query(new Request("https://app.test/app/child"))),
    });
    expect(response).toBeInstanceOf(Response);
    const body = await (response as Response).json();
    expect(body.loaderData.parent).toEqual({status: "ACTIVE", delay: 30});
    expect(body.loaderData.child).toEqual(body.loaderData.parent);
    expect(fixture.graphql).toHaveBeenCalledTimes(1);
    expect(fixture.authenticateAdmin).toHaveBeenCalledTimes(1);
    expect(fixture.readSettings).toHaveBeenCalledTimes(1);
    expect(fixture.readSubscription).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body.loaderData)).not.toMatch(/private-session-sentinel|graphql|accessToken/);
  });
  it("direct resource executes without page middleware or remote refresh", async () => {
    const handler = createStaticHandler([{id: "status", path: "/status", loader}]);
    const result = await handler.queryRoute(new Request("https://app.test/status"), {
      routeId: "status", requestContext: new RouterContextProvider(),
    });
    expect(result).toEqual({status: "ACTIVE", delay: 30});
    expect(fixture.graphql).not.toHaveBeenCalled();
    expect(fixture.lookup).toHaveBeenCalledTimes(1);
    expect(fixture.readSettings).toHaveBeenCalledTimes(1);
  });
  it("document POST revalidation gets fresh persisted state with shared HTTP context", async () => {
    const handler = createStaticHandler([{id: "page", path: "/app", middleware: [merchantPageContextMiddleware], loader, action}]);
    const request = new Request("https://app.test/app", {method: "POST", body: "intent=save"});
    const result = await handler.query(request, {
      requestContext: new RouterContextProvider(),
      generateMiddlewareResponse: async query => Response.json(await query(request)),
    });
    const body = await (result as Response).json();
    expect(body.loaderData.page).toEqual({status: "SUSPENDED", delay: 75});
    expect(methods).toEqual(["POST", "GET"]);
    expect(fixture.lookup).toHaveBeenCalledTimes(2);
    expect(fixture.readSettings).toHaveBeenCalledTimes(2);
    expect(fixture.graphql).not.toHaveBeenCalled();
  });
  it("SPA action then loader revalidation uses distinct fresh contexts", async () => {
    const router = createMemoryRouter([{id: "page", path: "/app", middleware: [merchantPageContextMiddleware], loader, action}], {
      initialEntries: ["/app"], getContext: () => new RouterContextProvider(),
    });
    try {
      await new Promise<void>(resolve => {
        if (router.state.initialized) return resolve();
        const unsubscribe = router.subscribe(state => {if (state.initialized) {unsubscribe(); resolve();}});
      });
      await router.navigate("/app", {formMethod: "post", formData: new FormData()});
      expect(router.state.loaderData.page).toEqual({status: "SUSPENDED", delay: 75});
      expect(methods).toEqual(["GET", "POST", "GET"]);
    } finally {router.dispose();}
  });
});


it("connects real migrated layout/home loaders through real profile resolver and middleware", async () => {
  const layout = await import("../../app/routes/app/route");
  const home = await import("../../app/routes/app/home/route");
  const handler = createStaticHandler([{
    id: "layout", path: "/app", middleware: layout.middleware, loader: layout.loader,
    children: [{id: "home", index: true, loader: home.loader}],
  }]);
  const request = new Request("https://app.test/app");
  const response = await handler.query(request, {
    requestContext: new RouterContextProvider(),
    generateMiddlewareResponse: async query => Response.json(await query(request)),
  });
  const body = await (response as Response).json();
  expect(body.errors).toBeNull();
  expect(body.loaderData.layout.merchantExperienceState).toBe("ACTIVE");
  expect(body.loaderData.home.merchantExperienceState).toBe("ACTIVE");
  expect(fixture.authenticateAdmin).toHaveBeenCalledTimes(1);
  expect(fixture.graphql).toHaveBeenCalledTimes(1);
  expect(fixture.lookup).toHaveBeenCalledTimes(1);
  expect(fixture.readSubscription).toHaveBeenCalledTimes(1);
  expect(fixture.readSettings).toHaveBeenCalledTimes(1);
  // Home composes its presentation from the shared scalar context.
  expect(commercialProjection).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(body.loaderData)).not.toMatch(/private-session-sentinel|accessToken|authentication/);
});


it.each(["subscription", "settings"])("owns lazy %s database failure through real Shared JSON", async row => {
  const records: string[] = [];
  vi.spyOn(console, "error").mockImplementation(record => {records.push(String(record));});
  const source = Object.assign(new Error("lazy-database-marker", {cause: new Error("lazy-cause-marker")}), {code: "P2021"});
  const read = row === "subscription" ? fixture.readSubscription : fixture.readSettings;
  read.mockRejectedValue(source);
  try {
    const merchant = await getMerchantRequestContext({
      request: new Request("https://app.test/status"), context: new RouterContextProvider(),
    });
    await expect(row === "subscription" ? merchant.readSubscription() : merchant.readSettings()).rejects.toBe(source);
    const data = JSON.parse(records[0]).data;
    expect(data.origin).toBe("database");
    expect(data.shopId).toBe(fixture.rows.shop.id);
    expect(data.databaseCode).toBe("P2021");
    expect(data.error.message).toBe("lazy-database-marker");
    expect(data.causeChain[0].message).toBe("lazy-cause-marker");
    expect(data.providerError).toBeUndefined();
    expect(fixture.graphql).not.toHaveBeenCalled();
  } finally {vi.restoreAllMocks();}
});


// Real production route exports and access helpers; SDK/Prisma/domain ports remain simulated.
it.each(["settings", "recoveries"])("shares app middleware context through the production %s chain", async route => {
  const layout = await import("../../app/routes/app/route");
  const child = route === "settings"
    ? await import("../../app/routes/app/recovery-settings/route")
    : await import("../../app/routes/app/recoveries/route");
  const path = route === "settings" ? "recovery-settings" : "recoveries";
  const handler = createStaticHandler([{
    id: "layout", path: "/app", middleware: layout.middleware, loader: layout.loader,
    children: [{id: "child", path, loader: child.loader}],
  }]);
  const request = new Request(`https://app.test/app/${path}?shopId=foreign-shop`);
  const response = await handler.query(request, {
    requestContext: new RouterContextProvider(),
    generateMiddlewareResponse: async query => Response.json(await query(request)),
  });
  const body = await (response as Response).json();
  expect(body.errors).toBeNull();
  expect(body.loaderData.layout.merchantExperienceState).toBe("ACTIVE");
  if (route === "settings") {
    expect(body.loaderData.child.aiResponseDelayMinutes).toBe(0);
    expect(body.loaderData.child.features.revision).toBe("fixture");
  } else {
    expect(body.loaderData.child.state).toBe("ready");
    expect(readRecoveryPage).toHaveBeenCalledWith(fixture.rows.shop.id, expect.any(Object));
  }
  expect(fixture.authenticateAdmin).toHaveBeenCalledTimes(1);
  expect(fixture.graphql).toHaveBeenCalledTimes(1);
  expect(fixture.lookup).toHaveBeenCalledExactlyOnceWith({where: {domain: fixture.rows.shop.domain}});
  expect(fixture.readSubscription).toHaveBeenCalledTimes(1);
  expect(fixture.readSettings).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(body.loaderData)).not.toMatch(/private-session-sentinel|accessToken|authentication|foreign-shop/);
});
