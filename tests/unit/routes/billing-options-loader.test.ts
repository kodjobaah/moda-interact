import { beforeEach, describe, expect, it, vi } from "vitest";
import { commercialReadFixture } from "../../fixtures/commercial-read-context";
import { MerchantBillingPresentationReadService } from "../../../app/services/billing/merchant-billing-presentation.server";
const ports = vi.hoisted(() => ({ context: vi.fn(), presentation: vi.fn() }));
vi.mock("@/services/shop/merchant-request-context.server", () => ({ getMerchantRequestContext: ports.context }));
vi.mock("@/services/billing/billing.service", () => ({ billingService: { readMerchantBillingPresentation: ports.presentation } }));
import { loader } from "../../../app/routes/app/billing/options/route";
const args = (query = "") => ({ request: new Request(`https://merchant.test/app/billing/options${query}`), context: {} }) as Parameters<typeof loader>[0];

beforeEach(() => vi.clearAllMocks());
describe("billing options loader", () => {
  function setup() {
    const fixture = commercialReadFixture();
    const readSubscription = vi.fn(async () => fixture.subscription);
    const service = new MerchantBillingPresentationReadService(fixture.provider, fixture.database as never);
    ports.context.mockResolvedValue({ shop: fixture.shop, readSubscription,
      authentication: { session: { shop: fixture.shop.domain } } });
    ports.presentation.mockImplementation(input => service.readOptions({ ...input, now: fixture.input.now }));
    return { ...fixture, readSubscription };
  }
  it("uses one seeded context and presentation invocation, retaining current/pending selection fields", async () => {
    const fixture = setup();
    const result = await loader(args("?plan_change=unverified&requested_plan_handle=other"));
    expect(result).toMatchObject({ verificationState: "ACTIVE_SUBSCRIPTION", lifecycleState: "ACTIVE",
      currentContract: { mappedModaPlanName: "Current plan" }, requestedSelection: { shopifyPlanHandle: "other" },
      usageHistoryAvailable: true, purchaseHistoryAvailable: true });
    expect(ports.context).toHaveBeenCalledOnce(); expect(fixture.readSubscription).toHaveBeenCalledOnce();
    expect(ports.presentation).toHaveBeenCalledOnce(); expect(fixture.calls()).toBe(8);
    expect(fixture.database.subscription.findUnique).not.toHaveBeenCalled(); expect(fixture.database.$transaction).not.toHaveBeenCalled();
  });
  it("keeps a durable shell and independent local capacity during provider outage", async () => {
    const fixture = setup(); fixture.provider.getActiveSubscription.mockRejectedValue(new Error("controlled provider outage"));
    const result = await loader(args());
    expect(result).toMatchObject({ commercial: null, topUp: null, currentContract: { mappedModaPlanName: "Current plan" },
      capacity: { availability: "AVAILABLE" }, verificationState: "VERIFICATION_UNAVAILABLE", lifecycleState: "ACTIVE" });
    expect(JSON.stringify(result)).not.toContain("controlled provider outage");
  });
  it("retains the successfully read current contract when capacity-only persistence fails", async () => {
    const fixture = setup(); fixture.database.shopEntitlementCounter.findMany.mockRejectedValue(new Error("private counter failure"));
    expect(await loader(args())).toMatchObject({ capacity: null, topUp: null, currentContract: { mappedModaPlanName: "Current plan" } });
  });
  it("preserves frozen state, cancellation and pending-choice behavior", async () => {
    const fixture = setup(); fixture.subscription.status = "FROZEN"; fixture.live.cancelAtPeriodEnd = true;
    const result = await loader(args("?plan_change=mismatch&requested_plan_handle=growth"));
    expect(result).toMatchObject({ verificationState: "FROZEN", lifecycleState: "FROZEN", scheduledCancellation: true, requestedSelection: null });
  });
  it("retains authentication and active-Shop/surface checks before read composition", async () => {
    const fixture = setup(); fixture.shop.status = "UNINSTALLED";
    await expect(loader(args())).rejects.toMatchObject({ status: 302 });
    expect(ports.presentation).not.toHaveBeenCalled();
    fixture.shop.status = "ACTIVE"; fixture.shop.onboardingCompleted = false;
    await expect(loader(args())).rejects.toMatchObject({ status: 302 });
    expect(ports.presentation).not.toHaveBeenCalled();
    const redirect = new Response(null, { status: 302 }); ports.context.mockRejectedValueOnce(redirect);
    await expect(loader(args())).rejects.toBe(redirect);
  });
});
