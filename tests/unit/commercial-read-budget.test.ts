import { beforeEach, describe, expect, it, vi } from "vitest";
import { commercialReadFixture } from "../fixtures/commercial-read-context";
import { MerchantBillingPresentationReadService } from "../../app/services/billing/merchant-billing-presentation.server";
import { getMerchantPromotionPage } from "../../app/services/promotions/promotion.service";
const ports = vi.hoisted(() => ({ context: vi.fn(), period: vi.fn(), periods: vi.fn(), events: vi.fn(), aggregate: vi.fn(), raw: vi.fn() }));
vi.mock("@/services/shop/merchant-request-context.server", () => ({ getMerchantRequestContext: ports.context }));
vi.mock("../../app/db.server", () => ({ default: { billingPeriod: { findFirst: ports.period, findMany: ports.periods },
  usageEvent: { findMany: ports.events, aggregate: ports.aggregate }, $queryRaw: ports.raw } }));
import { loader as selectLoader } from "../../app/routes/app/billing/select/route";
import { readUsageHistory } from "../../app/services/usage/history.server";
beforeEach(() => vi.clearAllMocks());

describe("commercial page method budgets", () => {
  it("uses eight domain/credential methods and one Partner observation for healthy options", async () => {
    const fixture = commercialReadFixture();
    const page = await new MerchantBillingPresentationReadService(fixture.provider, fixture.database as never).readOptions(fixture.input);
    expect(fixture.calls()).toBe(8);
    expect(fixture.provider.getActiveSubscription).toHaveBeenCalledOnce();
    expect(fixture.database.shop.findUnique).not.toHaveBeenCalled();
    expect(fixture.database.subscription.findUnique).not.toHaveBeenCalled();
    expect(fixture.database.usageEvent.aggregate).not.toHaveBeenCalled();
    expect(fixture.database.$transaction).not.toHaveBeenCalled();
    expect(page.capacity?.availability).toBe("AVAILABLE");
    process.stdout.write(JSON.stringify({ branch: "paid_options", suppliedContext: true, domainAndCredentialMethods: fixture.calls(), providerObservations: 1, writes: 0 }) + "\n");
  });
  it("keeps duplicate current/pending identities inside one distinct operational-plan batch", async () => {
    const fixture = commercialReadFixture(); fixture.subscription.pendingPlanId = fixture.plan.id;
    fixture.live.pendingFlatRatePlan = { handle: fixture.live.planHandle, price: { amount: "20.00", currency: "USD" }, effectiveAt: fixture.period.periodEnd };
    await new MerchantBillingPresentationReadService(fixture.provider, fixture.database as never).readOptions(fixture.input);
    expect(fixture.database.billingPlan.findMany).toHaveBeenCalledWith({ where: { OR: [
      { id: { in: [fixture.plan.id] } }, { shopifyPlanHandle: { in: [fixture.live.planHandle] } },
    ] } });
    expect(fixture.calls()).toBe(8);
  });
  it.each([false, true])("uses four local Home methods (three without a Free period), Free=%s", async free => {
    const fixture = commercialReadFixture();
    if (free) { fixture.plan.kind = "FREE"; fixture.subscription.billingPeriodId = null; }
    const result = await new MerchantBillingPresentationReadService(fixture.provider, fixture.database as never)
      .readHome({ ...fixture.input, pricingCatalogue: [fixture.pricingPlan] });
    expect(fixture.calls()).toBe(free ? 3 : 4);
    process.stdout.write(JSON.stringify({ branch: free ? "free_home" : "paid_home", suppliedContext: true, domainMethods: fixture.calls(), providerObservations: 0 }) + "\n");
    expect(fixture.provider.getActiveSubscription).not.toHaveBeenCalled();
    expect(fixture.database.merchantPricingPlan.findMany).not.toHaveBeenCalled();
    expect(fixture.database.shop.findUnique).not.toHaveBeenCalled();
    expect(fixture.database.subscription.findUnique).not.toHaveBeenCalled();
    expect(result.subscription?.pendingPlan?.name).toBe("Pending plan");
  });
  it.each(["ACTIVE", "FROZEN"] as const)("select derives %s from scalar context with no page-data reads", async status => {
    const fixture = commercialReadFixture(); fixture.subscription.status = status;
    const redirect = vi.fn((location: string) => new Response(null, { status: 302, headers: { Location: location } }));
    const readSubscription = vi.fn(async () => fixture.subscription);
    ports.context.mockResolvedValue({ shop: fixture.shop, readSubscription,
      authentication: { session: { shop: fixture.shop.domain }, redirect } });
    const result = selectLoader({ request: new Request("https://merchant.test/app/billing/select"), context: {} } as never);
    if (status === "FROZEN") await expect(result).rejects.toMatchObject({ status: 403 });
    else await expect(result).resolves.toMatchObject({ status: 302 });
    expect(ports.context).toHaveBeenCalledOnce(); expect(readSubscription).toHaveBeenCalledOnce();
    expect(fixture.calls()).toBe(0); expect(fixture.provider.getActiveSubscription).not.toHaveBeenCalled();
    process.stdout.write(JSON.stringify({ branch: "select", status, contextCalls: ports.context.mock.calls.length, scalarReads: readSubscription.mock.calls.length, controlledSeededContext: true, domainMethods: 0, providerObservations: 0 }) + "\n");
  });
  it.each([1, 100, 10_000])("uses five promotion page methods for a catalogue of %i translated offers", async count => {
    const offers = Array.from({ length: count }, (_, index) => ({ id: `campaign-${index}`, scope: "GLOBAL", status: "ACTIVE",
      startsAt: new Date("2026-09-01"), expiresAt: new Date("2026-10-01"), quantity: 10,
      translations: [{ merchantTitle: `Offer ${index}`, merchantDescription: "Details" }], promotionalCreditGrants: [],
    }));
    const database = {
      promotionCampaign: { count: vi.fn(async (query: { where: unknown }) => { expect(query.where).toBeDefined(); return count; }), findMany: vi.fn(async ({ skip, take }: { skip: number; take: number }) => offers.slice(skip, skip + take)) },
      merchantPromotionSelection: { findUnique: vi.fn(async () => null) },
      promotionalCreditGrant: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      shop: { findUnique: vi.fn() }, subscription: { findUnique: vi.fn() },
    };
    const page = await getMerchantPromotionPage({ shopId: "shop-1", shopStatus: "ACTIVE", subscriptionStatus: "ACTIVE", planId: "plan-1",
      locale: "en", offerPage: 99999, historyPage: 1, now: new Date("2026-09-15") }, database as never);
    expect(page.offers).toHaveLength(count === 1 ? 1 : count % 6 || 6);
    expect(page.offersPagination.page).toBe(Math.ceil(count / 6));
    expect(database.promotionCampaign.count).toHaveBeenCalledOnce(); expect(database.promotionCampaign.findMany).toHaveBeenCalledOnce();
    expect(database.merchantPromotionSelection.findUnique).toHaveBeenCalledOnce();
    expect(database.promotionalCreditGrant.count).toHaveBeenCalledOnce(); expect(database.promotionalCreditGrant.findMany).toHaveBeenCalledOnce();
    expect(database.shop.findUnique).not.toHaveBeenCalled(); expect(database.subscription.findUnique).not.toHaveBeenCalled();
    process.stdout.write(JSON.stringify({ branch: "promotion_page", catalogueSize: count, suppliedContext: true, pageDataMethods: 5, returnedRows: page.offers.length }) + "\n");
    const countWhere = database.promotionCampaign.count.mock.calls[0][0];
    expect(database.promotionCampaign.findMany).toHaveBeenCalledWith(expect.objectContaining({ ...countWhere, take: 6,
      orderBy: [{ expiresAt: "asc" }, { createdAt: "desc" }, { id: "asc" }] }));
  });
  it.each([false, true])("uses two usage reads when empty and four plus one bounded source query when selected=%s", async selected => {
    const period = { id: "period-1", status: "OPEN", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-10-01") };
    ports.period.mockResolvedValue(selected ? period : null); ports.periods.mockResolvedValue(selected ? [period] : []);
    ports.events.mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({ id: `usage-${index}`, quantity: 1,
      metric: "RECOVERY_CONVERSATION", idempotencyKey: `key-${index}`, sourceId: `source-${index}`, occurredAt: period.periodStart })));
    ports.aggregate.mockResolvedValue({ _count: { _all: 100 }, _sum: { quantity: 100 } }); ports.raw.mockResolvedValue([]);
    const page = await readUsageHistory("shop-1", new URLSearchParams("pageSize=100&page=20000000"));
    const methods = [ports.period, ports.periods, ports.events, ports.aggregate].reduce((sum, method) => sum + method.mock.calls.length, 0);
    expect(methods).toBe(selected ? 4 : 2); expect(ports.raw).toHaveBeenCalledTimes(selected ? 1 : 0);
    process.stdout.write(JSON.stringify({ branch: selected ? "usage_selected" : "usage_empty", repositoryMethods: methods, rawSourceQueries: ports.raw.mock.calls.length }) + "\n");
    if (selected) { expect(page.usageEvents).toHaveLength(100); expect(page.usagePagination.total).toBe(100);
      expect(ports.events).toHaveBeenCalledWith(expect.objectContaining({ take: 100, skip: 1999999900 })); }
  });
});
