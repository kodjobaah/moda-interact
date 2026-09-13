import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const beginReinstallReconciliation = vi.fn();
const enqueueBillingSubscriptionReconcileBestEffort = vi.fn();

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: {
    resolveShopifyShop,
    beginReinstallReconciliation,
  },
}));
vi.mock("../../../app/services/billing/billing-reconciliation.service", () => ({
  enqueueBillingSubscriptionReconcileBestEffort,
}));

const { loader } = await import("../../../app/routes/auth/catchall/route");

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    admin: { id: "shopify-admin" },
    session: { shop: "merchant.myshopify.com" },
  });
  resolveShopifyShop.mockResolvedValue({
    id: "shop-1",
    status: "ACTIVE",
  });
});

describe("auth catchall reinstall gate", () => {
  it("leaves an active shop lifecycle unchanged", async () => {
    await expect(loader({ request: new Request("https://example.test/auth/callback") })).resolves.toBeNull();

    expect(beginReinstallReconciliation).not.toHaveBeenCalled();
    expect(enqueueBillingSubscriptionReconcileBestEffort).not.toHaveBeenCalled();
  });

  it("schedules an uninstalled shop before redirecting to restoration", async () => {
    const reconciliation = {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      reinstallPendingAt: new Date("2026-09-14T00:00:00.000Z"),
      expectedNextReconcileAt: new Date("2026-09-14T00:00:00.000Z"),
    };
    resolveShopifyShop.mockResolvedValue({ id: "shop-1", status: "UNINSTALLED" });
    beginReinstallReconciliation.mockResolvedValue(reconciliation);

    let error: unknown;
    try {
      await loader({ request: new Request("https://example.test/auth/callback") });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Response);
    expect((error as Response).headers.get("Location")).toBe("/app/reinstalling");
    expect(enqueueBillingSubscriptionReconcileBestEffort).toHaveBeenCalledWith(reconciliation);
  });
});