import { describe, expect, it } from "vitest";
import {
  buildDiscountSyncJob,
  hasReadDiscountsScope,
  isDiscountSyncEligible,
} from "../../../app/services/discounts/shopify-discount-lifecycle.service";

describe("Shopify discount lifecycle contract", () => {
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