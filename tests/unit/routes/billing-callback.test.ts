import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  redirect: vi.fn((location: string) => ({ location })),
  resolveShop: vi.fn(),
  syncSubscription: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: { syncSubscription: mocks.syncSubscription },
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: mocks.resolveShop },
}));

import { loader } from "../../../app/routes/app.billing.callback";

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    status: "ACTIVE",
    observedShopifyPlanHandle: "growth",
    planId: "growth-1",
    pendingShopifyPlanHandle: null,
    pendingPlanId: null,
    pendingEffectiveAt: null,
    ...overrides,
  };
}

function request(planHandle?: string) {
  const suffix = planHandle === undefined ? "" : `?plan_handle=${planHandle}`;
  return new Request(`https://app.test/app/billing/callback${suffix}`);
}

async function runLoader(planHandle?: string) {
  return loader({ request: request(planHandle) } as never);
}

describe("billing callback verification", () => {
  it("accepts a verified mapped current plan", async () => {
    mocks.authenticateAdmin.mockResolvedValue({
      admin: {},
      redirect: mocks.redirect,
      session: { shop: "example.myshopify.com" },
    });
    mocks.resolveShop.mockResolvedValue({ id: "shop-1" });
    mocks.syncSubscription.mockResolvedValue(subscription());

    await runLoader("growth");

    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing?billing=success");
  });

  it("accepts a verified mapped pending plan without replacing current entitlement", async () => {
    mocks.authenticateAdmin.mockResolvedValue({
      admin: {},
      redirect: mocks.redirect,
      session: { shop: "example.myshopify.com" },
    });
    mocks.resolveShop.mockResolvedValue({ id: "shop-1" });
    mocks.syncSubscription.mockResolvedValue(subscription({
      observedShopifyPlanHandle: "growth",
      planId: "growth-1",
      pendingShopifyPlanHandle: "starter",
      pendingPlanId: "starter-1",
      pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
    }));

    await runLoader("starter");

    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing?billing=success");
  });

  it.each([
    ["NO_CONTRACT", { status: "NO_CONTRACT", planId: null }],
    ["UNMAPPED", { status: "UNMAPPED", planId: null }],
    ["SYNC_ERROR", { status: "SYNC_ERROR", planId: null }],
    ["current handle mismatch", subscription({ observedShopifyPlanHandle: "other" })],
    ["missing current plan id", subscription({ planId: null })],
    ["missing pending plan id", subscription({ pendingShopifyPlanHandle: "starter", pendingPlanId: null, pendingEffectiveAt: new Date() })],
    ["missing pending effective boundary", subscription({ pendingShopifyPlanHandle: "starter", pendingPlanId: "starter-1", pendingEffectiveAt: null })],
  ])("does not report success for %s", async (_label, projection) => {
    mocks.authenticateAdmin.mockResolvedValue({
      admin: {},
      redirect: mocks.redirect,
      session: { shop: "example.myshopify.com" },
    });
    mocks.resolveShop.mockResolvedValue({ id: "shop-1" });
    mocks.syncSubscription.mockResolvedValue(projection);

    await runLoader("starter");

    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing?billing=inactive");
  });

  it("does not allow an untrusted requested handle to create success", async () => {
    mocks.authenticateAdmin.mockResolvedValue({
      admin: {},
      redirect: mocks.redirect,
      session: { shop: "example.myshopify.com" },
    });
    mocks.resolveShop.mockResolvedValue({ id: "shop-1" });
    mocks.syncSubscription.mockResolvedValue(subscription());

    await runLoader("unknown");

    expect(mocks.redirect).toHaveBeenCalledWith("/app/billing?billing=inactive");
  });

  it("keeps the missing plan_handle 400 behavior", async () => {
    mocks.syncSubscription.mockClear();
    mocks.authenticateAdmin.mockResolvedValue({
      admin: {},
      redirect: mocks.redirect,
      session: { shop: "example.myshopify.com" },
    });

    await expect(runLoader()).rejects.toMatchObject({ status: 400 });
    expect(mocks.syncSubscription).not.toHaveBeenCalled();
  });
});