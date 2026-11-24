import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  resolveShop: vi.fn(),
  getMerchantRequestContext: vi.fn(),
  assertActiveShop: vi.fn(),
  getSubscriptionProjection: vi.fn(),
  syncSubscription: vi.fn(),
  transaction: vi.fn(),
  updateShopOnboarding: vi.fn(),
  updateSettingsOnboarding: vi.fn(),
  provisionTemplates: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("../../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: mocks.resolveShop },
}));
vi.mock("../../../app/services/shop/merchant-request-context.server", () => ({
  getMerchantRequestContext: mocks.getMerchantRequestContext,
}));
vi.mock("../../../app/services/shop/shop-access-policy", () => ({
  assertActiveShop: mocks.assertActiveShop,
}));
vi.mock("../../../app/services/recoveries/onboarding-template-assignments.server", () => ({
  ensureOnboardingRecoveryTemplatesBestEffort: mocks.provisionTemplates,
}));
vi.mock("../../../app/services/billing/billing.service", () => ({
  billingService: {
    getSubscriptionProjection: mocks.getSubscriptionProjection,
    syncSubscription: mocks.syncSubscription,
  },
}));
vi.mock("../../../app/db.server", () => ({
  default: { $transaction: mocks.transaction },
}));

import { action } from "../../../app/routes/app/onboarding/resume/route";

async function captureSharedErrorRecords(
  run: () => Promise<unknown>,
  options: { throwFromSink?: boolean } = {},
) {
  const records: Array<Record<string, unknown>> = [];
  const sink = vi.spyOn(console, "error").mockImplementation((line) => {
    if (options.throwFromSink) throw new Error("test Shared sink failure");
    if (typeof line !== "string") return;
    try { records.push(JSON.parse(line) as Record<string, unknown>); } catch { return; }
  });
  try { await run(); } finally { sink.mockRestore(); }
  return records;
}

function request(body = new URLSearchParams()) {
  return new Request("https://app.test/app/onboarding/resume", {
    method: "POST",
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({
    admin: {},
    session: { shop: "merchant.myshopify.com" },
  });
  mocks.resolveShop.mockResolvedValue({
    id: "shop-1",
    domain: "merchant.myshopify.com",
    status: "ACTIVE",
    onboardingCompleted: false,
  });
  mocks.getMerchantRequestContext.mockResolvedValue({
    shop: {
      id: "shop-1",
      domain: "merchant.myshopify.com",
      status: "ACTIVE",
      onboardingCompleted: false,
    },
  });
  mocks.getSubscriptionProjection.mockResolvedValue({
    status: "UNMAPPED",
    observedShopifyPlanHandle: "free",
    pendingShopifyPlanHandle: null,
    providerSubscriptionId: "gid://shopify/AppSubscription/1",
  });
  mocks.syncSubscription.mockResolvedValue({
    status: "ACTIVE",
    planId: "plan-free",
  });
  mocks.transaction.mockImplementation(async (callback) => callback({
    shop: { updateMany: mocks.updateShopOnboarding },
    shopSettings: { updateMany: mocks.updateSettingsOnboarding },
  }));
  mocks.updateShopOnboarding.mockResolvedValue({ count: 1 });
  mocks.updateSettingsOnboarding.mockResolvedValue({ count: 1 });
});

describe("onboarding resume action", () => {
  it("re-syncs an existing Shopify subscription and completes onboarding without a category", async () => {
    const response = await action({ request: request() } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, onboardingCompleted: true });
    expect(mocks.syncSubscription).toHaveBeenCalledWith("shop-1");
    expect(mocks.updateShopOnboarding).toHaveBeenCalledWith({
      where: { id: "shop-1" },
      data: { onboardingCompleted: true },
    });
    expect(mocks.updateSettingsOnboarding).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      data: { onboardingCompleted: true },
    });
  });

  it("does not complete onboarding when the provider subscription cannot be mapped to an active local plan", async () => {
    mocks.syncSubscription.mockResolvedValue({
      status: "UNMAPPED",
      planId: null,
    });

    const response = await action({ request: request() } as never);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "BILLING_RECONCILIATION_REQUIRED",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not call Shopify when there is no durable subscription evidence to resume", async () => {
    mocks.getSubscriptionProjection.mockResolvedValue(null);

    const response = await action({ request: request() } as never);

    expect(response.status).toBe(409);
    expect(mocks.syncSubscription).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects obsolete generation-bearing submissions without resuming billing", async () => {
    const response = await action({ request: request(new URLSearchParams({
      expectedPendingSelectionGeneration: "19",
    })) } as never);
    expect(response.status).toBe(400);
    expect(mocks.syncSubscription).not.toHaveBeenCalled();
  });

  it("emits the actual milestone persistence failure without reporting success", async () => {
    const failure = Object.assign(new Error("resume milestone marker"), { code: "P2025" });
    mocks.transaction.mockRejectedValue(failure);
    const records = await captureSharedErrorRecords(async () => {
      await expect(action({ request: request() } as never)).rejects.toBe(failure);
    });
    const record = records.find((item) => item.event === "billing.onboarding_milestone.persist_failed");
    const data = record?.data as Record<string, unknown>;

    expect(data).toMatchObject({
      operation: "persist_shopify_onboarding_milestone",
      stage: "two_row_transaction",
      origin: "database",
      shopId: "shop-1",
      databaseCode: "P2025",
      error: { name: "Error", message: "resume milestone marker" },
    });
    const isolatedRecords = await captureSharedErrorRecords(async () => {
      await expect(action({ request: request() } as never)).rejects.toBe(failure);
    }, { throwFromSink: true });
    expect(isolatedRecords).toHaveLength(0);
  });

  it("logs original synchronization failure but preserves the bounded 503 response", async () => {
    const cause = new Error("resume provider adapter marker");
    const failure = Object.assign(new Error("resume projection marker", { cause }), { code: "P2034" });
    mocks.syncSubscription.mockRejectedValue(failure);
    const records = await captureSharedErrorRecords(async () => {
      const response = await action({ request: request() } as never);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: "BILLING_RECONCILIATION_FAILED" });
    });
    const record = records.find((item) => item.event === "billing.onboarding_resume.sync_failed");

    expect(record?.data).toMatchObject({
      operation: "sync_subscription_for_onboarding_resume",
      stage: "provider_or_projection",
      origin: "database",
      shopId: "shop-1",
      databaseCode: "P2034",
      error: { name: "Error", message: "resume projection marker" },
      causeChain: [{ name: "Error", message: "resume provider adapter marker" }],
    });
    const isolatedRecords = await captureSharedErrorRecords(async () => {
      const response = await action({ request: request() } as never);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: "BILLING_RECONCILIATION_FAILED" });
    }, { throwFromSink: true });
    expect(isolatedRecords).toHaveLength(0);
  });
});
