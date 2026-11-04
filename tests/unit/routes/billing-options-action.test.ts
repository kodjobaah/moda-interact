import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryCreditPurchaseRequestService } from "../../../app/services/billing/recovery-credit-purchase-request.service";

const ports = vi.hoisted(() => ({ context: vi.fn(), purchase: vi.fn(), capacity: vi.fn(), commercial: vi.fn() }));
vi.mock("@/services/shop/merchant-request-context.server", () => ({ getMerchantRequestContext: ports.context }));
vi.mock("@/services/billing/billing.service", () => ({ billingService: {
  requestRecoveryCreditPack: ports.purchase, getMerchantRecoveryCapacityState: ports.capacity,
  getMerchantShopifySubscriptionState: ports.commercial,
} }));
vi.mock("@/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("@/services/shop/shop.service", () => ({ shopService: {} }));
vi.mock("../../../app/routes/app/home/overview.server", () => ({ overviewEmbed: {} }));
import { action } from "../../../app/routes/app/billing/options/route";

const id = "11111111-1111-4111-8111-111111111111";
function args(fields: Record<string, string> = {}) {
  return { request: new Request("https://merchant.test/app/billing/options", { method: "POST",
    body: new URLSearchParams({ intent: "BUY_RECOVERY_CREDIT_PACK", purchaseId: id, eventHandle: "pack", ...fields }) }),
    context: {}, params: {} } as Parameters<typeof action>[0];
}
function merchant(status = "ACTIVE", onboardingCompleted = true) {
  return { shop: { id: "trusted-shop", status, onboardingCompleted }, authentication: {},
    readSubscription: vi.fn(async () => ({ status: "ACTIVE" })) };
}
beforeEach(() => { vi.clearAllMocks(); ports.context.mockResolvedValue(merchant()); });

describe("billing options action", () => {
  it("replays the actual service receipt during a provider outage without prevalidation", async () => {
    const provider = { getSubscriptionLifecycleSnapshot: vi.fn().mockRejectedValue(new Error("provider offline")) };
    const catalogue = { readMerchantPricingPlan: vi.fn().mockRejectedValue(new Error("catalogue offline")) };
    const receipt = { id, shopId: "trusted-shop", provider: "SHOPIFY", status: "REQUESTED", currentAmount: 0,
      usageEvent: { shopifyReportState: "PENDING" } };
    const database = { recoveryCreditPurchase: { findUnique: vi.fn(async () => receipt) }, $transaction: vi.fn() };
    const service = new RecoveryCreditPurchaseRequestService(provider as never, database as never, catalogue as never);
    ports.purchase.mockImplementation(service.requestRecoveryCreditPack.bind(service));
    expect(await action(args({ shopId: "forged-shop" }))).toEqual({
      purchase: { status: "REQUESTED", currentAmount: 0, usageReportState: "PENDING" },
    });
    expect(ports.purchase).toHaveBeenCalledWith("trusted-shop", "BUY_RECOVERY_CREDIT_PACK", id, "pack");
    expect(provider.getSubscriptionLifecycleSnapshot).not.toHaveBeenCalled();
    expect(catalogue.readMerchantPricingPlan).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(ports.capacity).not.toHaveBeenCalled();
    expect(ports.commercial).not.toHaveBeenCalled();
  });
  it.each([{ shopId: "other", provider: "SHOPIFY" }, { shopId: "trusted-shop", provider: "WOOCOMMERCE" }])("rejects a foreign receipt %j", async receipt => {
    const service = new RecoveryCreditPurchaseRequestService({} as never,
      { recoveryCreditPurchase: { findUnique: async () => receipt } } as never, {} as never);
    ports.purchase.mockImplementation(service.requestRecoveryCreditPack.bind(service));
    await expect(action(args())).rejects.toThrow("another shop or billing provider");
  });
  it("preserves the new-admission result DTO and delegates field checks", async () => {
    ports.purchase.mockResolvedValue({ status: "REQUESTED", currentAmount: 0, usageEvent: null });
    expect(await action(args())).toEqual({ purchase: { status: "REQUESTED", currentAmount: 0, usageReportState: "UNKNOWN" } });
    const service = new RecoveryCreditPurchaseRequestService({} as never, {} as never, {} as never);
    ports.purchase.mockImplementation(service.requestRecoveryCreditPack.bind(service));
    await expect(action(args({ purchaseId: "bad" }))).rejects.toThrow("valid recovery credit purchase ID");
    await expect(action(args({ intent: "unsupported" }))).rejects.toThrow("Unsupported billing action");
    await expect(action(args({ eventHandle: "x".repeat(129) }))).rejects.toThrow("valid recovery credit offer");
  });
  it("preserves authentication and independent active/surface authorization", async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: "/auth" } });
    ports.context.mockRejectedValueOnce(redirect);
    await expect(action(args())).rejects.toBe(redirect);
    ports.context.mockResolvedValueOnce(merchant("UNINSTALLED"));
    await expect(action(args())).rejects.toMatchObject({ status: 302 });
    ports.context.mockResolvedValueOnce(merchant("ACTIVE", false));
    await expect(action(args())).rejects.toMatchObject({ status: 302 });
    expect(ports.purchase).not.toHaveBeenCalled();
  });
});
