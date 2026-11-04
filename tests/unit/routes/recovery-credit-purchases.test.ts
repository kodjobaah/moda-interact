import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ context: vi.fn(), history: vi.fn(), batch: vi.fn(), reactivate: vi.fn(),
  graphql: vi.fn(), records: [] as unknown[], brokenSink: false }));
vi.mock("@/services/shop/merchant-request-context.server", () => ({ getMerchantRequestContext: ports.context }));
vi.mock("@/services/billing/recovery-credit-purchase-management.service", () => ({ recoveryCreditPurchaseManagementService: {
  listPurchaseHistory: ports.history, requestRefundBatch: ports.batch, reactivateRefund: ports.reactivate,
} }));
vi.mock("@modainteract/moda-interact-shared/logging", async importOriginal => {
  const actual = await importOriginal<typeof import("@modainteract/moda-interact-shared/logging")>();
  return { ...actual, createLogger: (options: Parameters<typeof actual.createLogger>[0]) => actual.createLogger({
    ...options, sink: record => { if (ports.brokenSink) throw new Error("sink unavailable"); ports.records.push(JSON.parse(JSON.stringify(record))); },
  }) };
});
import { action, loader } from "../../../app/routes/app/billing/recovery-credit-purchases/route";
function args(fields: Array<[string, string]> = []) {
  return { request: new Request("https://merchant.test/app/billing/recovery-credit-purchases?filter=ALL&pageSize=20", {
    method: "POST", body: new URLSearchParams(fields),
  }), context: {}, params: {} } as Parameters<typeof action>[0];
}
function merchant(status = "ACTIVE", onboardingCompleted = true, subscriptionStatus = "ACTIVE") {
  return { shop: { id: "trusted", shopifyShopId: "gid://shopify/Shop/1", status, onboardingCompleted },
    authentication: { admin: { graphql: ports.graphql }, session: { onlineAccessInfo: { associated_user: { id: 123 } } } },
    readSubscription: vi.fn(async () => ({ status: subscriptionStatus })) };
}
beforeEach(() => {
  vi.clearAllMocks(); ports.records.length = 0; ports.brokenSink = false;
  ports.context.mockResolvedValue(merchant());
  ports.graphql.mockImplementation(async () => Response.json({ data: { shop: { plan: { partnerDevelopment: false } } } }));
  ports.batch.mockResolvedValue({ outcomes: [] }); ports.history.mockResolvedValue({ purchases: [] });
});
const refund = (ids = ["purchase"]) => args([["intent", "request_refund"], ["requestId", "request"], ...ids.map(id => ["purchaseId", id] as [string, string])]);
describe("purchase history route", () => {
  it("uses trusted tenant context and retains filter/page and refund DTOs", async () => {
    await loader(args());
    expect(ports.history).toHaveBeenCalledWith(expect.objectContaining({ shopId: "trusted", pageSize: 20, status: undefined, shopifyPartnerDevelopment: false }));
    await action(refund(["purchase", "purchase"]));
    expect(ports.batch).toHaveBeenCalledWith(expect.objectContaining({ shopId: "trusted", purchaseIds: ["purchase"], shopifyUserId: "123" }));
  });
  it("bounds unique selections before Admin or mutation work", async () => {
    expect((await action(refund(Array.from({ length: 21 }, (_, i) => `id-${i}`))) as Response).status).toBe(400);
    expect((await action(args([["intent", "invalid"]])) as Response).status).toBe(400);
    expect(ports.graphql).not.toHaveBeenCalled();
    expect(ports.batch).not.toHaveBeenCalled();
    expect((await action(refund(Array(25).fill("same")))) as Response).toMatchObject({ status: 200 });
  });
  it("reactivates without provider verification, preserving missing-field validation", async () => {
    ports.reactivate.mockResolvedValue({ code: "REACTIVATED" });
    expect(await (await action(args([["intent", "reactivate"], ["purchaseId", "purchase"]])) as Response).json()).toEqual({ code: "REACTIVATED" });
    expect((await action(args([["intent", "reactivate"]])) as Response).status).toBe(400);
    expect(ports.reactivate).toHaveBeenCalledWith({ shopId: "trusted", purchaseId: "purchase" });
    expect(ports.graphql).not.toHaveBeenCalled();
  });
  it("keeps authentication, active Shop and surface checks before provider work", async () => {
    const redirect = new Response(null, { status: 302 });
    ports.context.mockRejectedValueOnce(redirect);
    await expect(loader(args())).rejects.toBe(redirect);
    for (const value of [merchant("UNINSTALLED"), merchant("ACTIVE", false)]) {
      ports.context.mockResolvedValueOnce(value);
      await expect(action(refund())).rejects.toMatchObject({ status: 302 });
    }
    expect(ports.graphql).not.toHaveBeenCalled();
    expect(ports.batch).not.toHaveBeenCalled();
    // The historic active-only projection maps CANCELLED to no contract.
    ports.context.mockResolvedValueOnce(merchant("ACTIVE", true, "CANCELLED"));
    await loader(args());
    expect(ports.history).toHaveBeenCalledOnce();
  });
  it.each([200, 503])("fails closed on original GraphQL/HTTP %i evidence with real Shared JSON", async status => {
    ports.graphql.mockResolvedValue(Response.json({ errors: [{ message: "original ADMIN_DENIED email=person@example.test access_token=secret-sentinel", extensions: { code: "ACCESS_DENIED" } }] },
      { status, headers: { "x-request-id": "request-safe" } }));
    await expect(action(refund())).rejects.toThrow("original ADMIN_DENIED");
    const output = JSON.stringify(ports.records);
    expect(ports.records).toHaveLength(1);
    process.stdout.write(JSON.stringify({ evidence: "admin_provider_failure", records: ports.records }) + "\n");
    for (const marker of ["ADMIN_DENIED", "ACCESS_DENIED", "request-safe", "provider_response", String(status)]) expect(output).toContain(marker);
    for (const secret of ["person@example.test", "secret-sentinel"]) expect(output).not.toContain(secret);
    expect(ports.batch).not.toHaveBeenCalled();
  });
  it("retains the SDK exception cause and safe original source once", async () => {
    const cause = new Error("transport causal marker access_token=secret-sentinel");
    const error = Object.assign(new Error("SDK original marker", { cause }), {
      body: { errors: { graphQLErrors: [{ message: "SDK graphql marker", extensions: { code: "SDK_DENIED" } }] } },
      response: { status: 429, headers: new Headers({ "x-request-id": "sdk-request" }) },
    });
    ports.graphql.mockRejectedValue(error);
    await expect(loader(args())).rejects.toMatchObject({ cause: error });
    const output = JSON.stringify(ports.records);
    for (const marker of ["SDK original marker", "SDK_DENIED", "transport causal marker", "sdk_exception", "sdk-request"]) expect(output).toContain(marker);
    expect(output).not.toContain("secret-sentinel");
    expect(ports.records).toHaveLength(1);
  });
  it.each([{}, { data: { shop: { plan: { partnerDevelopment: "true" } } } }, { errors: {}, data: { shop: { plan: { partnerDevelopment: true } } } }, { errors: [null], data: { shop: { plan: { partnerDevelopment: true } } } }])("treats malformed data as internal evidence %j", async body => {
    ports.graphql.mockResolvedValue(Response.json(body));
    await expect(action(refund())).rejects.toThrow("Unable to verify");
    expect(JSON.stringify(ports.records)).toContain('"origin":"internal"');
    expect(ports.batch).not.toHaveBeenCalled();
  });
  describe.each([200, 503])("malformed Admin HTTP %i", status => {
    it.each(["short", "long"])("excludes %s response text from actual Shared output while preserving the original cause", async kind => {
      const body = kind === "short" ? "SECRETXYZ" : `PARTIAL_BODY_SENTINEL:${"private-body-content".repeat(1000)}:BODY_TAIL_SENTINEL`;
      const response = new Response(body, { status, headers: { "x-request-id": "safe-parse-request" } });
      const nativeJson = response.json.bind(response);
      let parseFailure: unknown;
      vi.spyOn(response, "json").mockImplementation(async () => {
        try { return await nativeJson(); } catch (error) { parseFailure = error; throw error; }
      });
      ports.graphql.mockResolvedValue(response);
      let thrown: unknown;
      try { await action(refund()); } catch (error) { thrown = error; }
      expect(parseFailure).toBeInstanceOf(SyntaxError);
      expect((parseFailure as Error).message).toContain(kind === "short" ? "SECRETXYZ" : "PARTIAL_BO");
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).cause).toBe(parseFailure);
      expect((thrown as Error).message).not.toContain(kind === "short" ? "SECRETXYZ" : "PARTIAL_BO");
      expect(ports.batch).not.toHaveBeenCalled();
      expect(ports.history).not.toHaveBeenCalled();
      expect(ports.reactivate).not.toHaveBeenCalled();
      expect(ports.records).toHaveLength(1);
      const output = JSON.stringify(ports.records);
      for (const fragment of ["SECRETXYZ", "PARTIAL_BO", "private-body-content", "BODY_TAIL_SENTINEL"]) expect(output).not.toContain(fragment);
      expect(ports.records[0]).toMatchObject({ event: "shopify.billing.provider_failed", data: {
        operation: "verify_refund_development_store", httpStatus: status, providerRequestId: "safe-parse-request",
        failureKind: status === 200 ? "MALFORMED_RESPONSE" : "HTTP",
        origin: status === 200 ? "internal" : "provider_response",
        error: { message: "Shopify Admin development-store response JSON parsing failed." },
        causeChain: [{ name: "SyntaxError", message: "Shopify Admin development-store response JSON parsing failed." }],
      } });
      process.stdout.write(JSON.stringify({ evidence: "safe_admin_parse_failure", status, bodyKind: kind, records: ports.records }) + "\n");
    });
  });
  it.each([200, 503])("preserves malformed-response rejection with a throwing Shared sink at HTTP %i", async status => {
    ports.brokenSink = true;
    const response = new Response("PRIVATE_PARSE_SENTINEL", { status });
    const nativeJson = response.json.bind(response);
    let parseFailure: unknown;
    vi.spyOn(response, "json").mockImplementation(async () => {
      try { return await nativeJson(); } catch (error) { parseFailure = error; throw error; }
    });
    ports.graphql.mockResolvedValue(response);
    let thrown: unknown;
    try { await action(refund()); } catch (error) { thrown = error; }
    expect(parseFailure).toBeInstanceOf(SyntaxError);
    expect(thrown).toMatchObject({ message: "Shopify Admin development-store response JSON parsing failed." });
    expect((thrown as Error).cause).toBe(parseFailure);
    expect(ports.batch).not.toHaveBeenCalled();
    expect(ports.records).toHaveLength(0);
  });
  it("isolates a throwing real Shared sink without allowing an unverified refund", async () => {
    ports.brokenSink = true;
    ports.graphql.mockRejectedValue(new Error("original SDK failure"));
    await expect(action(refund())).rejects.toThrow("original SDK failure");
    expect(ports.batch).not.toHaveBeenCalled();
  });
});
