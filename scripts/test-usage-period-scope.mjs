import assert from "node:assert/strict";
import test from "node:test";
import { shopifyPeriodUsageWhere } from "../app/services/usage/period-scope.ts";

const period = {
  id: "period-previous",
  periodStart: new Date("2026-10-01T00:00:00Z"),
  periodEnd: new Date("2026-11-01T00:00:00Z"),
};

test("Shopify period usage is scoped to recovery credit events for this shop and provider", () => {
  const { OR, ...scope } = shopifyPeriodUsageWhere("shop-a", period);
  assert.deepEqual(scope, {
    shopId: "shop-a",
    provider: "SHOPIFY",
    metric: "RECOVERY_CONVERSATION",
  });
  assert.equal(OR.length, 2);
});

test("original debits retain the period FK or use a half-open window for purchased and promotional usage", () => {
  const [original] = shopifyPeriodUsageWhere("shop-a", period).OR;
  assert.deepEqual(original, {
    correctionOfUsageEventId: null,
    OR: [
      { billingPeriodId: period.id },
      {
        billingPeriodId: null,
        sourceType: {
          in: ["PURCHASED_RECOVERY_CREDITS", "PROMOTIONAL_RECOVERY_CREDITS"],
        },
        occurredAt: { gte: period.periodStart, lt: period.periodEnd },
      },
    ],
  });
});

test("late corrections inherit only the matching original debit, not their own period or occurrence time", () => {
  const [original, correction] = shopifyPeriodUsageWhere("shop-a", period).OR;
  assert.deepEqual(correction, {
    correctionOfUsageEvent: {
      is: {
        shopId: "shop-a",
        provider: "SHOPIFY",
        metric: "RECOVERY_CONVERSATION",
        ...original,
      },
    },
  });
});
