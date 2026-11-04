import { describe, expect, it } from "vitest";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { commercialReadFixture } from "../../../fixtures/commercial-read-context";
import { MerchantBillingPresentationReadService } from "../../../../app/services/billing/merchant-billing-presentation.server";
import { BillingService } from "../../../../app/services/billing/billing.service";
import { createShopifyBillingProviderError } from "../../../../app/services/billing/providers/shopify-billing-diagnostics.server";

function harness(brokenSink = false) {
  const fixture = commercialReadFixture();
  const records: unknown[] = [];
  const diagnostics = createLogger({ serviceName: "moda-interact", environment: "test", sink: record => {
    if (brokenSink) throw new Error("sink unavailable");
    records.push(JSON.parse(JSON.stringify(record)));
  } });
  return { ...fixture, records, diagnostics,
    service: new MerchantBillingPresentationReadService(fixture.provider, fixture.database as never, diagnostics) };
}
const failure = () => Object.assign(new Error("original DB marker email=person@example.test access_token=secret-sentinel", {
  cause: new Error("original causal marker https://files.example.test/private?signature=signed-sentinel"),
}), { code: "P2010" });

describe("merchant commercial presentation", () => {
  it("has no constructor I/O and delegates both chosen facade paths", async () => {
    const fixture = harness();
    const facade = new BillingService(fixture.provider, fixture.database as never);
    expect(fixture.calls()).toBe(0);
    expect("getMerchantBillingState" in facade).toBe(false);
    expect("getMerchantRecoveryCapacityState" in facade).toBe(false);
    expect(fixture.provider.getActiveSubscription).not.toHaveBeenCalled();
    const options = await facade.readMerchantBillingPresentation(fixture.input);
    expect(options).toMatchObject({ currentContract: { mappedModaPlanName: "Current plan" }, capacity: { availability: "AVAILABLE" } });
    const home = await facade.readMerchantHomeBillingPresentation({ ...fixture.input, pricingCatalogue: [fixture.pricingPlan] });
    expect(home.subscription).toMatchObject({ planName: "Current plan", pendingPlan: { name: "Pending plan" } });
  });
  it("preserves separate balances, quotes, current cycle and pending plan names", async () => {
    const fixture = harness();
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.capacity).toMatchObject({ paidIncluded: { remaining: 20 }, purchased: { available: 11 }, freeLifetime: { remaining: 5 } });
    expect(result.topUp).toMatchObject({ paidIncluded: { remaining: 20 }, purchasedRecoveryCredits: { available: 11 }, purchaseEligible: true, billingPeriodPhase: "ACTIVE" });
    expect(result.topUp?.recoveryCreditOffers[0]).toMatchObject({ quotedPackPrice: { amountMinor: 500, currency: "USD" } });
    expect(result.topUp).not.toHaveProperty("usageQuantity");
    expect(fixture.database.usageEvent.aggregate).not.toHaveBeenCalled();
  });
  it.each(["TRIALING", "FROZEN", "NO_CONTRACT"] as const)("preserves %s capacity without modifying the scalar row", async status => {
    const fixture = harness();
    fixture.subscription.status = status;
    fixture.subscription.lastProviderLifecycleState = status === "NO_CONTRACT" ? "CANCELED" : null;
    const before = structuredClone(fixture.subscription);
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.capacity?.availability).toBe(status === "FROZEN" ? "CONTRACT_FROZEN" : status === "NO_CONTRACT" ? "POST_CONTRACT_AVAILABLE" : "AVAILABLE");
    expect(fixture.subscription).toEqual(before);
    if (status === "NO_CONTRACT") expect(result.capacity?.topUpConfiguration.enabled).toBe(false);
  });
  it("keeps local authority when the live handle differs and batches a pending live handle", async () => {
    const fixture = harness();
    fixture.live.planHandle = "unmapped-live";
    fixture.live.currentFlatRatePlan.handle = "unmapped-live";
    fixture.live.pendingFlatRatePlan = { handle: "scale", price: { amount: "20.00", currency: "USD" }, effectiveAt: fixture.period.periodEnd };
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.commercial).toMatchObject({ mappingStatus: "UNMAPPED", pendingModaMapping: { name: "Pending plan" } });
    expect(result.currentContract?.shopifyPlanHandle).toBe("growth");
    expect(result.capacity?.reconciledPlanMapping?.shopifyPlanHandle).toBe("growth");
    expect(fixture.database.billingPlan.findMany).toHaveBeenCalledOnce();
    expect(fixture.database.merchantPricingPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shopifyPlanHandle: { in: ["growth", "unmapped-live"] } } }));
  });
  it("retains unavailable state for missing cycle and inactive operational plan", async () => {
    const fixture = harness();
    fixture.subscription.billingPeriodId = null;
    let result = await fixture.service.readOptions(fixture.input);
    expect(fixture.database.billingPeriod.findFirst).not.toHaveBeenCalled();
    expect(result.capacity?.availability).toBe("CONFIGURATION_UNAVAILABLE");
    expect(result.topUp?.purchaseEligible).toBe(false);
    fixture.plan.active = false;
    result = await fixture.service.readOptions(fixture.input);
    expect(result.capacity?.reconciledPlanMapping).toBeNull();
  });
  it.each(["shopId", "subscriptionId", "planId"] as const)("rejects a mismatched period %s before projection", async key => {
    const fixture = harness();
    fixture.period[key] = "foreign";
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.capacity).toBeNull();
    expect(result.topUp).toBeNull();
    expect(fixture.records).toHaveLength(1);
    expect(JSON.stringify(fixture.records)).toContain("identity mismatch");
  });
  it.each(["plans", "period", "counters", "selection", "pricing", "receipt"])("owns a shared %s database failure exactly once", async stage => {
    const fixture = harness();
    const error = failure();
    const ports = {
      plans: fixture.database.billingPlan.findMany, period: fixture.database.billingPeriod.findFirst,
      counters: fixture.database.shopEntitlementCounter.findMany, selection: fixture.database.merchantPromotionSelection.findUnique,
      pricing: fixture.database.merchantPricingPlan.findMany, receipt: fixture.database.recoveryCreditPurchase.findFirst,
    };
    ports[stage as keyof typeof ports].mockRejectedValue(error);
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.topUp).toBeNull();
    expect(fixture.records).toHaveLength(1);
    if (stage === "period") process.stdout.write(JSON.stringify({ evidence: "presentation_read_failure", records: fixture.records }) + "\n");
    const output = JSON.stringify(fixture.records);
    for (const marker of ["original DB marker", "original causal marker", "P2010", "shop-1", "database"]) expect(output).toContain(marker);
    for (const secret of ["person@example.test", "secret-sentinel", "signed-sentinel"]) expect(output).not.toContain(secret);
    if (stage !== "receipt") expect(result.capacity).toBeNull();
    if (stage !== "plans") expect(result.currentContract?.mappedModaPlanName).toBe("Current plan");
  });
  it("retains the durable shell/local successes during provider outage without duplicate source output", async () => {
    const fixture = harness();
    const error = createShopifyBillingProviderError({ operation: "active_subscription", failureKind: "HTTP", origin: "provider_response",
      message: "original upstream marker", httpStatus: 503, providerRequestId: "safe-request",
      providerErrors: [{ message: "source detail", code: "UNAVAILABLE" }], cause: new Error("upstream cause marker") }, fixture.diagnostics);
    fixture.provider.getActiveSubscription.mockRejectedValue(error);
    const result = await fixture.service.readOptions(fixture.input);
    expect(result).toMatchObject({ commercial: null, currentContract: { mappedModaPlanName: "Current plan" }, capacity: { availability: "AVAILABLE" }, topUp: null });
    expect(fixture.records).toHaveLength(1);
    for (const marker of ["original upstream marker", "UNAVAILABLE", "safe-request", "503", "upstream cause marker"]) expect(JSON.stringify(fixture.records)).toContain(marker);
  });
  it("distinguishes explicit provider absence from failed verification", async () => {
    const fixture = harness();
    fixture.provider.getActiveSubscription.mockResolvedValue(null as never);
    expect((await fixture.service.readOptions(fixture.input)).commercial?.status).toBe("NO_ACTIVE_SUBSCRIPTION");
  });
  it("owns top-up invariant failures without inventing provider evidence", async () => {
    const fixture = harness();
    fixture.database.recoveryCreditPurchase.findFirst.mockResolvedValue({ provider: "SHOPIFY", usageEventId: null } as never);
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.topUp).toBeNull();
    expect(result.capacity?.availability).toBe("AVAILABLE");
    expect(JSON.stringify(fixture.records)).toContain("Shopify recovery credit purchase evidence is invalid");
    expect(JSON.stringify(fixture.records)).toContain('"origin":"internal"');
  });
  it.each([false, true])("retains Home summary and nullable capacity when its read fails, broken sink=%s", async broken => {
    const fixture = harness(broken);
    fixture.database.shopEntitlementCounter.findMany.mockRejectedValue(failure());
    const result = await fixture.service.readHome({ ...fixture.input, pricingCatalogue: [fixture.pricingPlan] });
    expect(result).toMatchObject({ capacity: null, subscription: { planName: "Current plan", pendingPlan: { name: "Pending plan", effectiveAt: fixture.period.periodEnd.toISOString() } } });
    expect(fixture.provider.getActiveSubscription).not.toHaveBeenCalled();
    if (!broken) expect(JSON.stringify(fixture.records)).toContain("P2010");
  });
  it("retains observed-handle Home fallback when the operational plan is missing", async () => {
    const fixture = harness(); fixture.database.billingPlan.findMany.mockResolvedValue([]);
    const result = await fixture.service.readHome({ ...fixture.input, pricingCatalogue: [fixture.pricingPlan] });
    expect(result.subscription).toMatchObject({ planHandle: "growth", planName: "growth", pendingPlan: null });
    expect(result.capacity?.availability).toBe("CONFIGURATION_UNAVAILABLE");
    expect(fixture.database.subscription.findUnique).not.toHaveBeenCalled();
    expect(fixture.database.merchantPricingPlan.findMany).not.toHaveBeenCalled();
  });
  it("preserves legitimate missing-counter defaults while keeping paid-period capacity separate", async () => {
    const fixture = harness(); fixture.database.shopEntitlementCounter.findMany.mockResolvedValue([]);
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.capacity).toMatchObject({ availability: "AVAILABLE", freeLifetime: null, purchased: { available: 0 }, paidIncluded: { remaining: 20 } });
    expect(fixture.records).toHaveLength(0);
  });
  it("rejects a foreign counter without presenting zero as a failed balance", async () => {
    const fixture = harness(); fixture.counters[0].shopId = "foreign";
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.capacity).toBeNull(); expect(result.topUp).toBeNull();
    expect(JSON.stringify(fixture.records)).toContain("balance tenant mismatch");
  });
  it.each(["missing_row", "null_end"])("retains unavailable paid-cycle predicates for %s", async kind => {
    const fixture = harness();
    if (kind === "missing_row") fixture.database.billingPeriod.findFirst.mockResolvedValue(null as never);
    else fixture.subscription.currentPeriodEnd = null;
    const result = await fixture.service.readOptions(fixture.input);
    expect(result.capacity?.availability).toBe("CONFIGURATION_UNAVAILABLE");
    expect(result.topUp?.purchaseEligible).toBe(false);
    expect(result.topUp?.billingPeriodPhase).toBeNull();
  });
  it("derives the transition phase from the supplied fixed request time without enabling purchase", async () => {
    const fixture = harness();
    const result = await fixture.service.readOptions({ ...fixture.input, now: fixture.period.periodEnd });
    expect(result.topUp).toMatchObject({ billingPeriodPhase: "RECONCILING", purchaseEligible: false });
  });
  it("falls back to an exact local-handle pricing read when absent from the active catalogue", async () => {
    const fixture = harness();
    const result = await fixture.service.readHome({ ...fixture.input, pricingCatalogue: [] });
    expect(result.capacity?.topUpConfiguration).toEqual({ enabled: true, creditsPerPack: 10 });
    expect(fixture.database.merchantPricingPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { shopifyPlanHandle: { in: ["growth"] } } }));
  });
});
