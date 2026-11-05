import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ActionFunctionArgs} from "react-router";
const output = vi.hoisted(() => ({records: [] as Array<{event: string; data: Record<string, unknown>}>, broken: false}));
const ports = vi.hoisted(() => ({redisCtor: vi.fn(), connect: vi.fn(), ping: vi.fn(), disconnect: vi.fn(), redisOn: vi.fn(), zcard: vi.fn(), zrange: vi.fn(),
  queueCtor: vi.fn(), queueOn: vi.fn(), getJob: vi.fn(), close: vi.fn(), add: vi.fn(), state: vi.fn(),
  pgConnect: vi.fn(), pgQuery: vi.fn(), pgEnd: vi.fn(), pgOn: vi.fn(),
  context: vi.fn(), projection: vi.fn(), sync: vi.fn(), activate: vi.fn(), milestone: vi.fn()}));
vi.mock("@modainteract/moda-interact-shared/logging", async original => {
  const real = await original<typeof import("@modainteract/moda-interact-shared/logging")>();
  return {...real, createLogger: (options: Parameters<typeof real.createLogger>[0]) => real.createLogger({...options, sink: record => {
    if (output.broken) throw new Error("sink failed"); output.records.push(JSON.parse(JSON.stringify(record)));
  }})};
});
vi.mock("ioredis", () => ({default: class {
  constructor() {ports.redisCtor();} connect = ports.connect; ping = ports.ping; disconnect = ports.disconnect;
  on = ports.redisOn; zcard = ports.zcard; zrange = ports.zrange;
}}));
vi.mock("pg", () => ({Client: class {connect = ports.pgConnect; query = ports.pgQuery; end = ports.pgEnd; on = ports.pgOn;}}));
vi.mock("bullmq", () => ({Queue: class {
  constructor() {ports.queueCtor();} on = ports.queueOn; getJob = ports.getJob; close = ports.close; add = ports.add;
}}));
vi.mock("../../app/db.server", () => ({default: {}}));
vi.mock("../../app/services/shop/merchant-request-context.server", () => ({getMerchantRequestContext: ports.context}));
vi.mock("../../app/services/billing/billing.service", () => ({billingService: {getSubscriptionProjection: ports.projection, syncSubscription: ports.sync}}));
vi.mock("../../app/services/store-profile/store-category-activation.server", () => ({activateInitialPendingStoreCategoryIfEligible: ports.activate}));
vi.mock("../../app/services/billing/onboarding-milestone.server", () => ({persistShopifyOnboardingMilestone: ports.milestone}));
import {checkPostgresReadiness, checkRedisReadiness, HEALTH_CHECK_TIMEOUT_MS} from "../../app/services/health/health-check.server";
import {readPendingRecoveries} from "../../app/services/pending-recovery/pending-recovery-reader.server";
import {SubscriptionEndedNotificationService, MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY} from "../../app/services/billing/subscription-ended-notification.service";
import {suggestStoreCategory} from "../../app/services/store-profile/shopify-taxonomy-suggestion.server";
import {action as resume} from "../../app/routes/app/onboarding/resume/route";
import {loader as probe} from "../../app/routes/system/telemetry-probe/route";
const pendingInput = {shopId: "shop-1", shopDomain: "shop.test", page: 1};
const source = (code = "ECONNREFUSED") => Object.assign(new Error("original dependency marker redis://private-host email=private@example.test", {cause: new Error("original dependency cause access_token=private-token")}), {code});
const failures = () => output.records.filter(record => record.event !== "telemetry.probe");
function evidence(broken: boolean, count = 1) {
  expect(failures()).toHaveLength(broken ? 0 : count); const json = JSON.stringify(output.records);
  if (!broken) for (const marker of ["original dependency marker", "original dependency cause"]) expect(json).toContain(marker);
  for (const secret of ["private-host", "private@example.test", "private-token"]) expect(json).not.toContain(secret);
}
beforeEach(() => {
  vi.resetAllMocks(); vi.resetModules(); output.records.length = 0; output.broken = false; vi.stubEnv("REDIS_URL", "redis://fixture.invalid");
  ports.connect.mockResolvedValue(undefined); ports.ping.mockResolvedValue("PONG"); ports.pgConnect.mockResolvedValue(undefined); ports.pgQuery.mockResolvedValue({rows: []}); ports.pgEnd.mockResolvedValue(undefined);
  ports.zcard.mockResolvedValue(0); ports.zrange.mockResolvedValue([]); ports.close.mockResolvedValue(undefined); ports.add.mockResolvedValue({});
  ports.context.mockResolvedValue({shop: {id: "shop-1", status: "ACTIVE", onboardingCompleted: false}});
  ports.projection.mockResolvedValue({providerSubscriptionId: "provider-fixture"}); ports.sync.mockResolvedValue({status: "ACTIVE", planId: "plan-1"});
  ports.activate.mockResolvedValue({kind: "ACTIVATED"});
});
afterEach(() => {vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();});
describe.each([false, true])("original fallback evidence, broken sink=%s", broken => {
  beforeEach(() => {output.broken = broken;});
  it.each(["connect", "ping"] as const)("keeps Redis %s failure false without duplicating its error event", async stage => {
    const error = source(); ports[stage].mockImplementationOnce(async () => {
      const listener = ports.redisOn.mock.calls[0][1] as (error: Error) => void; listener(error); throw error;
    });
    expect(await checkRedisReadiness("redis://fixture")).toBe(false); evidence(broken); expect(ports.disconnect).toHaveBeenCalledOnce();
  });
  it.each(["pgConnect", "pgQuery"] as const)("keeps PostgreSQL %s failure false", async stage => {
    ports[stage].mockRejectedValueOnce(source("P2010")); expect(await checkPostgresReadiness("postgres://fixture")).toBe(false); evidence(broken); expect(ports.pgEnd).toHaveBeenCalledOnce();
  });
  it("diagnoses cleanup failure without replacing the primary readiness result", async () => {
    ports.pgConnect.mockRejectedValueOnce(source("P2010")); ports.pgEnd.mockRejectedValueOnce(new Error("cleanup source marker"));
    expect(await checkPostgresReadiness("postgres://fixture")).toBe(false); evidence(broken, 2);
    if (!broken) expect(JSON.stringify(output.records)).toContain("cleanup source marker");
  });
  it("retains the original constructor rejection rather than changing its response semantics", async () => {
    const error = source(); ports.redisCtor.mockImplementationOnce(() => {throw error;});
    await expect(checkRedisReadiness("redis://fixture")).rejects.toBe(error); evidence(broken);
  });
  it("keeps a hanging Redis dependency bounded with an internal timeout diagnostic", async () => {
    vi.useFakeTimers(); ports.connect.mockReturnValueOnce(new Promise(() => {}));
    const result = checkRedisReadiness("redis://fixture"); await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);
    expect(await result).toBe(false); expect(failures()).toHaveLength(broken ? 0 : 1);
    if (!broken) expect(failures()[0].data.origin).toBe("internal");
  });
  it.each(["connect", "zcard", "zrange", "getJob", "state"] as const)("keeps pending %s failure unavailable", async stage => {
    if (stage === "getJob" || stage === "state") {ports.zcard.mockResolvedValue(1); ports.zrange.mockResolvedValue(["job-1", "1700000000000"]);}
    ports.getJob.mockResolvedValue({id: "job-1", name: "evaluate-pending-recovery", data: {shopId: "shop-1", shopDomain: "shop.test"}, getState: ports.state});
    ports[stage].mockRejectedValueOnce(source()); const result = await readPendingRecoveries(pendingInput);
    expect(result).toMatchObject({available: false, items: [], total: 0}); evidence(broken); expect(ports.close).toHaveBeenCalledOnce();
  });
  it("owns pending queue error events and failed cleanup without changing ready data", async () => {
    ports.connect.mockImplementationOnce(async () => {const listener = ports.queueOn.mock.calls[0][1] as (error: Error) => void; listener(source());});
    ports.close.mockRejectedValueOnce(new Error("pending cleanup marker"));
    expect((await readPendingRecoveries(pendingInput)).available).toBe(true); evidence(broken, 2);
  });
  it("keeps notification persistence/dispatch best-effort and preserves the invariant exception", async () => {
    const lifecycle = {provider: "SHOPIFY", planHandle: "basic", lifecycleIdentity: "fixture-cycle"};
    for (const stage of ["persistence", "dispatch"] as const) {
      output.records.length = 0; const error = source(stage === "persistence" ? "P2010" : "ECONNREFUSED");
      const db = {$transaction: vi.fn().mockImplementation(async () => {if (stage === "persistence") throw error; return "translation-1";})};
      const notify = new SubscriptionEndedNotificationService(db as never, async () => {throw error;});
      await expect(notify.notifySubscriptionEnded("shop-1", lifecycle)).resolves.toBeUndefined(); evidence(broken);
      if (!broken) expect(failures()[0].data.origin).toBe(stage === "persistence" ? "database" : "transport");
    }
    output.records.length = 0; const invariant = new Error(MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY);
    const notify = new SubscriptionEndedNotificationService({$transaction: async () => {throw invariant;}} as never);
    await expect(notify.notifySubscriptionEnded("shop-1", lifecycle)).rejects.toBe(invariant);
  });
  it("keeps failed postcommit reconciliation scheduling best-effort", async () => {
    const {enqueueBillingSubscriptionReconcileBestEffort} = await import("../../app/services/billing/billing-reconciliation.service");
    await expect(enqueueBillingSubscriptionReconcileBestEffort({shopId: "shop-1", subscriptionId: "subscription-1", expectedNextReconcileAt: new Date("2026-11-01T00:00:00Z")}, {add: vi.fn().mockRejectedValue(source())})).resolves.toBeUndefined(); evidence(broken);
  });
  it.each(["provider", "mapping"] as const)("preserves taxonomy %s failure evidence and category fallback", async stage => {
    const error = source(stage === "provider" ? "ECONNRESET" : "P2010");
    const admin = {graphql: vi.fn().mockImplementation(async () => {if (stage === "provider") throw error; return new Response('{"data":{"products":{"nodes":[]}}}');})};
    const mapping = {commerceStoreCategoryTaxonomyMapping: {findMany: vi.fn().mockRejectedValue(error)}};
    expect(await suggestStoreCategory(admin, [{id: "category-1"}], mapping as never)).toEqual({categoryId: "category-1", matchedMappingIds: []}); evidence(broken);
  });
  it("extracts actual provider GraphQL message/code/request ID without response data", async () => {
    const admin = {graphql: async () => new Response(JSON.stringify({errors: [{message: "original provider marker email=private@example.test", extensions: {code: "ACCESS_DENIED"}}], data: {customers: "private-response-data"}}), {status: 403, headers: {"x-request-id": "request-fixture"}})};
    expect((await suggestStoreCategory(admin, [{id: "category-1"}]))?.categoryId).toBe("category-1");
    const json = JSON.stringify(output.records); for (const secret of ["private@example.test", "private-response-data"]) expect(json).not.toContain(secret);
    if (!broken) for (const marker of ["original provider marker", "ACCESS_DENIED", "request-fixture"]) expect(json).toContain(marker);
  });
  it("records parser failure without exposing raw provider body", async () => {
    const admin = {graphql: async () => new Response("private-provider-body-sentinel")};
    expect((await suggestStoreCategory(admin, [{id: "category-1"}]))?.categoryId).toBe("category-1");
    expect(JSON.stringify(output.records)).not.toContain("private-provider-body-sentinel"); expect(failures()).toHaveLength(broken ? 0 : 1);
  });
  it.each(["sync", "activate"] as const)("keeps onboarding %s technical failure outcome", async stage => {
    const error = source("P2010"); ports[stage].mockRejectedValueOnce(error);
    const args = {request: new Request("https://app.test/app/onboarding/resume", {method: "POST", body: new URLSearchParams({expectedPendingSelectionGeneration: "1"})}), context: {}, params: {}} as unknown as ActionFunctionArgs;
    if (stage === "sync") expect((await resume(args)).status).toBe(503); else await expect(resume(args)).rejects.toBe(error);
    evidence(broken); expect(ports.milestone).not.toHaveBeenCalled();
  });
  it.each(["success", "network", "response"] as const)("keeps telemetry probe %s shape/status while protecting configured URL", async stage => {
    const target = "https://user:password-sentinel@probe.test/path?signed=signed-query-sentinel"; vi.stubEnv("TELEMETRY_PROBE_TARGET", target);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {if (stage === "network") throw source(); return new Response(null, {status: stage === "response" ? 503 : 200});}));
    const response = await probe(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json(); expect(body.probe.status).toBe(stage === "success" ? "OK" : stage === "network" ? "NETWORK_ERROR" : "UNEXPECTED_STATUS_503");
    for (const secret of [target, "password-sentinel", "signed-query-sentinel", "private-host", "private-token"]) expect(JSON.stringify({body, records: output.records})).not.toContain(secret);
    if (stage === "network") evidence(broken);
    if (stage === "response" && !broken) expect(failures()[0].data.httpStatus).toBe(503);
  });
});
