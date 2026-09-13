import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateAdmin = vi.fn();
const resolveShopifyShop = vi.fn();
const getReinstallSubscription = vi.fn();
const retryReinstallReconciliation = vi.fn();
const enqueueBillingSubscriptionReconcileBestEffort = vi.fn();

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: {
    resolveShopifyShop,
    getReinstallSubscription,
    retryReinstallReconciliation,
  },
}));
vi.mock("../../../app/services/billing/billing-reconciliation.service", () => ({
  enqueueBillingSubscriptionReconcileBestEffort,
}));

const { action, loader } = await import("../../../app/routes/app/reinstalling/route");

function loaderArgs(url: string) {
  return { request: new Request(url) } as Parameters<typeof loader>[0];
}

function actionArgs(request: Request) {
  return { request } as Parameters<typeof action>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({
    admin: { id: "shopify-admin" },
    session: { shop: "merchant.myshopify.com" },
  });
  resolveShopifyShop.mockResolvedValue({
    id: "shop-1",
    status: "UNINSTALLED",
    reinstallPendingAt: new Date("2026-09-14T00:00:00.000Z"),
  });
});

describe("reinstalling route", () => {
  it("renders pending state without product data reads", async () => {
    getReinstallSubscription.mockResolvedValue({
      nextReconcileAt: new Date("2026-09-14T00:05:00.000Z"),
    });

    await expect(loader(loaderArgs("https://example.test/app/reinstalling"))).resolves.toMatchObject({
      state: "pending",
    });
    expect(getReinstallSubscription).toHaveBeenCalledWith("shop-1");
  });

  it("renders stopped state when the durable schedule is absent", async () => {
    getReinstallSubscription.mockResolvedValue({ nextReconcileAt: null });

    await expect(loader(loaderArgs("https://example.test/app/reinstalling"))).resolves.toEqual({
      state: "stopped",
      nextReconcileAt: null,
    });
  });

  it("retries only through the explicit action and republishes the committed schedule", async () => {
    const reconciliation = {
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      reinstallPendingAt: new Date("2026-09-14T00:10:00.000Z"),
      expectedNextReconcileAt: new Date("2026-09-14T00:10:00.000Z"),
    };
    retryReinstallReconciliation.mockResolvedValue(reconciliation);
    const formData = new FormData();
    formData.set("intent", "retry");

    let error: unknown;
    try {
      await action(actionArgs(new Request("https://example.test/app/reinstalling", {
          method: "POST",
          body: formData,
        })));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Response);
    expect((error as Response).headers.get("Location")).toBe("/app/reinstalling");
    expect(retryReinstallReconciliation).toHaveBeenCalledWith("shop-1");
    expect(enqueueBillingSubscriptionReconcileBestEffort).toHaveBeenCalledWith(reconciliation);
  });
});