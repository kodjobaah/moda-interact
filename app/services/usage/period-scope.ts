import type { Prisma } from "@prisma/client";

export type UsagePeriodBoundary = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
};

/**
 * Usage is the signed RECOVERY_CONVERSATION ledger, not the number of
 * physical outreach attempts or reservations. Pooled credits are committed
 * without a billing-period FK; locate their debit in its entitlement window.
 * A correction belongs to its original debit's period, even when it was
 * recorded after that period closed. Never trust a correction's own timestamp
 * or source type to assign it to a different period.
 */
export function shopifyPeriodUsageWhere(
  shopId: string,
  period: UsagePeriodBoundary,
): Prisma.UsageEventWhereInput {
  const scope = {
    shopId,
    provider: "SHOPIFY",
    metric: "RECOVERY_CONVERSATION" as const,
  };
  const original: Prisma.UsageEventWhereInput = {
    correctionOfUsageEventId: null,
    OR: [
      { billingPeriodId: period.id },
      {
        billingPeriodId: null,
        sourceType: { in: ["PURCHASED_RECOVERY_CREDITS", "PROMOTIONAL_RECOVERY_CREDITS"] },
        occurredAt: { gte: period.periodStart, lt: period.periodEnd },
      },
    ],
  };
  return {
    ...scope,
    OR: [original, { correctionOfUsageEvent: { is: { ...scope, ...original } } }],
  };
}
