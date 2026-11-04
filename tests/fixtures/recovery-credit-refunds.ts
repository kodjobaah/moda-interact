import { randomUUID } from "node:crypto";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { PrismaClient } from "@prisma/client";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";
import { createPurchaseFixture } from "./recovery-credit-purchases";
import { RecoveryCreditPurchaseManagementService } from "../../app/services/billing/recovery-credit-purchase-management.service";

export async function createRefundFixture(database: PrismaClient, label: string) {
  const fixture = await createPurchaseFixture(database, label);
  const usageEvent = await database.usageEvent.create({ data: {
    shopId: fixture.shopId, billingPeriodId: fixture.period.id, metric: "RECOVERY_CREDIT_PACK_PURCHASE",
    quantity: 1, sourceType: "RECOVERY_CREDIT_PURCHASE", sourceId: randomUUID(), idempotencyKey: randomUUID(),
    provider: "SHOPIFY", shopifyReportState: "REPORTED",
  } });
  const purchase = await database.recoveryCreditPurchase.create({ data: {
    id: randomUUID(), shopId: fixture.shopId, planId: fixture.planId, billingPeriodId: fixture.period.id,
    provider: "SHOPIFY", status: "ACTIVE", creditsGranted: 10, currentAmount: 10, reservedAmount: 0,
    shopifyPlanHandleSnapshot: fixture.planHandle, shopifyEventHandleSnapshot: fixture.eventHandle,
    providerSubscriptionIdSnapshot: deriveShopifyProviderContextIdentity({
      providerSubscriptionId: fixture.providerSubscription.providerSubscriptionId,
      planHandle: fixture.planHandle, currentPeriodStart: fixture.period.periodStart, currentPeriodEnd: fixture.period.periodEnd,
    }), usageEventId: usageEvent.id,
    providerUsageQuantityBeforeSnapshot: 0, providerUsageQuantityAfterSnapshot: 1,
    providerUsageCostBeforeSnapshot: "0.00", providerUsageCostAfterSnapshot: "5.00",
    providerUsageCostCurrencyBeforeSnapshot: "USD", providerUsageCostCurrencyAfterSnapshot: "USD",
    providerValuationConfirmedAt: new Date(), providerPriceSnapshot: { kind: "FIXED", amount: "5.00", currency: "USD" },
    providerPurchaseAmount: "5.00", providerPurchaseCurrency: "USD",
  } });
  const counter = await database.shopEntitlementCounter.create({ data: {
    shopId: fixture.shopId, counter: "PURCHASED_RECOVERY_CREDITS", grantedQuantity: 10,
  } });
  const input = { shopId: fixture.shopId, purchaseId: purchase.id,
    shopifyShopId: `gid://shopify/Shop/${fixture.shopId.replace(/-shop$/, "")}`, requestId: randomUUID() };
  return { ...fixture, purchase, counter, input,
    service: (port = database, diagnostics?: StructuredLogger) => new RecoveryCreditPurchaseManagementService(port, fixture.provider, diagnostics),
    state: async () => ({
      purchase: await database.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: purchase.id } }),
      counter: await database.shopEntitlementCounter.findUniqueOrThrow({ where: { id: counter.id } }),
      refunds: await database.recoveryCreditRefund.findMany({ where: { purchaseId: purchase.id }, orderBy: { createdAt: "asc" } }),
    }),
  };
}
