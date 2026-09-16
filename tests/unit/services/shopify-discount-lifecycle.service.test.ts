import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscountSyncJob,
  hasReadDiscountsScope,
  isDiscountSyncEligible,
  enqueueSubscriptionActivatedDiscountSyncBestEffort,
  markDiscountCatalogueUnavailable,
} from "../../../app/services/discounts/shopify-discount-lifecycle.service";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  transaction: vi.fn(),
  shopFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  sessionFindFirst: vi.fn(),
  catalogueUpsert: vi.fn(),
  discountUpdateMany: vi.fn(),
}));

vi.mock("../../../app/db.server", () => ({
  default: { $transaction: mocks.transaction },
}));
vi.mock("../../../app/services/webhooks/shopify-webhook-queue.server", () => ({
  publishShopifyDiscountSyncJob: mocks.publish,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback({
    shop: { findUnique: mocks.shopFindUnique },
    $queryRaw: mocks.queryRaw,
    session: { findFirst: mocks.sessionFindFirst },
    shopifyDiscountCatalogue: { upsert: mocks.catalogueUpsert },
    shopifyDiscount: { updateMany: mocks.discountUpdateMany },
  }));
  mocks.catalogueUpsert.mockResolvedValue({});
  mocks.discountUpdateMany.mockResolvedValue({ count: 1 });
  mocks.publish.mockResolvedValue({ outcome: "enqueued" });
});

describe("Shopify discount lifecycle contract", () => {
  it("uses only the durable offline session for activation eligibility", async () => {
    mocks.shopFindUnique.mockResolvedValue({
      id: "shop-1",
      domain: "shop.myshopify.com",
      status: "ACTIVE",
      settings: { onboardingCompleted: true },
      subscription: { status: "ACTIVE" },
    });
    mocks.sessionFindFirst.mockResolvedValue({ scope: "read_products" });

    await enqueueSubscriptionActivatedDiscountSyncBestEffort("shop-1");

    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
      where: { shop: "shop.myshopify.com", isOnline: false },
      select: { scope: true },
      orderBy: { expires: "desc" },
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.catalogueUpsert).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("commits SYNC_REQUIRED before publishing for an eligible offline session", async () => {
    mocks.shopFindUnique.mockResolvedValue({
      id: "shop-1",
      domain: "shop.myshopify.com",
      status: "ACTIVE",
      settings: { onboardingCompleted: true },
      subscription: { status: "TRIALING" },
    });
    mocks.sessionFindFirst.mockResolvedValue({ scope: "read_products,read_discounts" });

    await enqueueSubscriptionActivatedDiscountSyncBestEffort("shop-1");

    expect(mocks.catalogueUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith({
      event: expect.objectContaining({
        shopId: "shop-1",
        shopDomain: "shop.myshopify.com",
        reason: "SUBSCRIPTION_ACTIVATED",
      }),
    });
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]);
  });

  it("preserves prior discount unavailableAt values while invalidating all rows", async () => {
    const eventTime = new Date("2026-09-16T17:00:00.000Z");
    await markDiscountCatalogueUnavailable({
      shopifyDiscountCatalogue: { upsert: mocks.catalogueUpsert },
      shopifyDiscount: { updateMany: mocks.discountUpdateMany },
    } as never, "shop-1", eventTime);

    expect(mocks.catalogueUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.discountUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { shopId: "shop-1" },
      data: { isAvailable: false },
    });
    expect(mocks.discountUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { shopId: "shop-1", unavailableAt: null },
      data: { unavailableAt: eventTime },
    });
  });

  it("requires the exact read_discounts scope", () => {
    expect(hasReadDiscountsScope("read_products, read_discounts")).toBe(true);
    expect(hasReadDiscountsScope("read_products")).toBe(false);
    expect(hasReadDiscountsScope("read_discount")).toBe(false);
  });

  it.each([
    ["ACTIVE", true, "ACTIVE", "read_discounts", true],
    ["ACTIVE", true, "TRIALING", "read_discounts", true],
    ["ACTIVE", true, "NO_CONTRACT", "read_discounts", false],
    ["ACTIVE", true, "ACTIVE", "read_products", false],
    ["UNINSTALLED", true, "ACTIVE", "read_discounts", false],
    ["ACTIVE", false, "ACTIVE", "read_discounts", false],
  ])("eligibility is %s", (shopStatus, onboardingCompleted, subscriptionStatus, scope, expected) => {
    expect(isDiscountSyncEligible({
      shopStatus,
      onboardingCompleted,
      subscriptionStatus,
      sessionScope: scope,
    })).toBe(expected);
  });

  it("builds a versioned webhook payload with canonical topic and timestamp", () => {
    expect(buildDiscountSyncJob({
      shopId: "shop-1",
      shopDomain: "shop.myshopify.com",
      reason: "DISCOUNT_WEBHOOK",
      requestedAt: new Date("2026-09-16T16:00:00.000Z"),
      deliveryId: "delivery-1",
      webhookTopic: "discounts/create",
    })).toEqual({
      schemaVersion: 1,
      shopId: "shop-1",
      shopDomain: "shop.myshopify.com",
      reason: "DISCOUNT_WEBHOOK",
      requestedAt: "2026-09-16T16:00:00.000Z",
      deliveryId: "delivery-1",
      webhookTopic: "discounts/create",
    });
  });
});