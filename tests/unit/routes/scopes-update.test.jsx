import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateWebhook: vi.fn(),
  transaction: vi.fn(),
  shopFindUnique: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionFindFirst: vi.fn(),
  lock: vi.fn(),
  isEligible: vi.fn(),
  hasScope: vi.fn(),
  markRequired: vi.fn(),
  markUnavailable: vi.fn(),
  buildJob: vi.fn(),
  publish: vi.fn(),
  webhookReceived: vi.fn(),
  webhookAuthFailure: vi.fn(),
  webhookRouteFailure: vi.fn(),
  webhookRouteOutcome: vi.fn(),
}));

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { webhook: mocks.authenticateWebhook },
}));
vi.mock("../../../app/db.server", () => ({
  default: { $transaction: mocks.transaction },
}));
vi.mock("../../../app/services/discounts/shopify-discount-lifecycle.service", () => ({
  buildDiscountSyncJob: mocks.buildJob,
  hasReadDiscountsScope: mocks.hasScope,
  isDiscountSyncEligible: mocks.isEligible,
  lockShopLifecycleRow: mocks.lock,
  markDiscountCatalogueSyncRequired: mocks.markRequired,
  markDiscountCatalogueUnavailable: mocks.markUnavailable,
}));
vi.mock("../../../app/services/webhooks/shopify-webhook-queue.server", () => ({
  publishShopifyDiscountSyncJob: mocks.publish,
}));
vi.mock("../../../app/services/webhooks/shopify-webhook-observability.server", () => ({
  recordShopifyWebhookReceived: mocks.webhookReceived,
  recordShopifyWebhookAuthenticationFailure: mocks.webhookAuthFailure,
  recordShopifyWebhookRouteFailure: mocks.webhookRouteFailure,
  recordShopifyWebhookRouteOutcome: mocks.webhookRouteOutcome,
}));

import { action } from "../../../app/routes/webhooks/app/scopes-update/route";

const shopRecord = {
  id: "shop-1",
  domain: "merchant.myshopify.com",
  status: "ACTIVE",
  settings: { onboardingCompleted: true },
  subscription: { status: "ACTIVE" },
};

function request() {
  return new Request("https://example.test/webhooks/app/scopes_update");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateWebhook.mockResolvedValue({
    payload: { current: "read_products,read_discounts" },
    session: { id: "session-1" },
    topic: "APP_SCOPES_UPDATE",
    shop: shopRecord.domain,
  });
  mocks.shopFindUnique
    .mockResolvedValueOnce({ id: shopRecord.id })
    .mockResolvedValueOnce(shopRecord);
  mocks.sessionFindFirst.mockResolvedValue({ scope: "read_products,read_discounts" });
  mocks.hasScope.mockReturnValue(true);
  mocks.isEligible.mockReturnValue(true);
  mocks.buildJob.mockReturnValue({ reason: "SCOPES_UPDATED" });
  mocks.publish.mockResolvedValue({ outcome: "enqueued" });
  mocks.transaction.mockImplementation(async (callback) => callback({
    shop: { findUnique: mocks.shopFindUnique },
    session: {
      update: mocks.sessionUpdate,
      findFirst: mocks.sessionFindFirst,
    },
  }));
});

describe("APP_SCOPES_UPDATE lifecycle ordering", () => {
  it("locks Shop before persisting scope and publishes after the transaction", async () => {
    let transactionResolved = false;
    mocks.transaction.mockImplementation(async (callback) => {
      const result = await callback({
        shop: { findUnique: mocks.shopFindUnique },
        session: {
          update: mocks.sessionUpdate,
          findFirst: mocks.sessionFindFirst,
        },
      });
      transactionResolved = true;
      return result;
    });

    await action({ request: request() });

    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sessionUpdate.mock.invocationCallOrder[0],
    );
    expect(mocks.sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sessionFindFirst.mock.invocationCallOrder[0],
    );
    expect(mocks.markRequired.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.lock.mock.invocationCallOrder[0],
    );
    expect(transactionResolved).toBe(true);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.webhookReceived).toHaveBeenCalledWith({
      request: expect.any(Request),
      route: "/webhooks/app/scopes_update",
    });
    expect(mocks.webhookRouteOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "/webhooks/app/scopes_update",
        topic: "APP_SCOPES_UPDATE",
        shopDomain: shopRecord.domain,
        shopId: shopRecord.id,
        outcome: "PROCESSED_APP_SCOPES_UPDATE_SYNC_REQUESTED",
      }),
    );
  });

  it("marks scope removal unavailable without publishing", async () => {
    mocks.authenticateWebhook.mockResolvedValue({
      payload: { current: "read_products" },
      session: { id: "session-1" },
      topic: "APP_SCOPES_UPDATE",
      shop: shopRecord.domain,
    });
    mocks.sessionFindFirst.mockResolvedValue({ scope: "read_products" });
    mocks.hasScope.mockReturnValue(false);
    mocks.isEligible.mockReturnValue(false);

    await action({ request: request() });

    expect(mocks.markUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.markRequired).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not trust payload read_discounts without persisted offline scope", async () => {
    mocks.sessionFindFirst.mockResolvedValue({ scope: "read_products" });
    mocks.hasScope.mockReturnValue(false);
    mocks.isEligible.mockReturnValue(false);

    await action({ request: request() });

    expect(mocks.markUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});