import type { BillingPlan, Prisma } from "@prisma/client";
import {
  BillingPeriodStatus,
  BillingPeriodEntitlementCounterKind,
  BillingPlanKind,
} from "@prisma/client";
import {
  APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS,
} from "@modainteract/moda-interact-shared/billing";

import type { BillingPeriodPhase } from "./billing.types";

type DurableBillingCycle = {
  billingPeriodId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  billingPeriod?: { id: string; periodStart: Date; periodEnd: Date } | null;
};

type CurrentBillingPeriodPlan = Pick<
  BillingPlan,
  | "id"
  | "name"
  | "kind"
  | "shopifyPlanHandle"
  | "includedRecoveryConversationAllowance"
>;

type CurrentBillingPeriodProjectionConflictReason =
  | "CLOSED_PERIOD"
  | "SUBSCRIPTION_MISMATCH"
  | "HANDLE_MISMATCH"
  | "PLAN_MISMATCH"
  | "PLAN_NAME_MISMATCH"
  | "PLAN_KIND_MISMATCH"
  | "INCLUDED_GRANT_MISMATCH"
  | "FREE_INCLUDED_COUNTER_PRESENT"
  | "INVALID_INCLUDED_ALLOWANCE"
  | "PAID_COUNTER_MISMATCH";

type CurrentBillingPeriodProjectionResult =
  | {
      kind: "READY";
      billingPeriodId: string;
      repaired: boolean;
    }
  | {
      kind: "CONFLICT";
      billingPeriodId: string | null;
      reason: CurrentBillingPeriodProjectionConflictReason;
    };

export function hasDurableBillingPeriod(subscription: DurableBillingCycle): boolean {
  return Boolean(
    subscription.billingPeriodId &&
    subscription.currentPeriodStart &&
    subscription.currentPeriodEnd &&
    subscription.billingPeriod &&
    subscription.billingPeriod.id === subscription.billingPeriodId &&
    subscription.billingPeriod.periodStart.getTime() === subscription.currentPeriodStart.getTime() &&
    subscription.billingPeriod.periodEnd.getTime() === subscription.currentPeriodEnd.getTime(),
  );
}

export function hasMatchingBillingCycle(
  subscription: DurableBillingCycle,
  providerSubscription: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null },
  expectedBillingPeriodId?: string,
): boolean {
  if (!hasDurableBillingPeriod(subscription)) return false;
  if (expectedBillingPeriodId && subscription.billingPeriodId !== expectedBillingPeriodId) return false;
  if (!providerSubscription.currentPeriodStart || !providerSubscription.currentPeriodEnd) return false;
  return providerSubscription.currentPeriodStart.getTime() === subscription.currentPeriodStart!.getTime() &&
    providerSubscription.currentPeriodEnd.getTime() === subscription.currentPeriodEnd!.getTime();
}

export async function ensureMappedCurrentBillingPeriodProjection(
  transaction: Prisma.TransactionClient,
  input: {
    shopId: string;
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    providerPlanHandle: string;
    plan: CurrentBillingPeriodPlan;
  },
): Promise<CurrentBillingPeriodProjectionResult> {
  const expectedGrant = input.plan.kind === BillingPlanKind.PAID_METERED
    ? input.plan.includedRecoveryConversationAllowance
    : null;

  if (
    input.plan.kind === BillingPlanKind.PAID_METERED &&
    (
      expectedGrant === null ||
      !Number.isSafeInteger(expectedGrant) ||
      expectedGrant < 0
    )
  ) {
    return {
      kind: "CONFLICT",
      billingPeriodId: null,
      reason: "INVALID_INCLUDED_ALLOWANCE",
    };
  }

  const existingPeriod = await transaction.billingPeriod.findUnique({
    where: {
      shopId_periodStart_periodEnd: {
        shopId: input.shopId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
    },
  });

  if (!existingPeriod) {
    const createdPeriod = await transaction.billingPeriod.create({
      data: {
        shopId: input.shopId,
        subscriptionId: input.subscriptionId,
        planId: input.plan.id,
        shopifyPlanHandleSnapshot: input.providerPlanHandle,
        planNameSnapshot: input.plan.name,
        planKindSnapshot: input.plan.kind,
        includedRecoveryCreditsGranted: expectedGrant,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: BillingPeriodStatus.OPEN,
      },
    });

    if (input.plan.kind === BillingPlanKind.PAID_METERED) {
      await transaction.billingPeriodEntitlementCounter.create({
        data: {
          shopId: input.shopId,
          billingPeriodId: createdPeriod.id,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
          grantedQuantity: expectedGrant as number,
          committedQuantity: 0,
          reservedQuantity: 0,
          forfeitedQuantity: 0,
          currentAllowanceQuantity: null,
        },
      });
    }

    return {
      kind: "READY",
      billingPeriodId: createdPeriod.id,
      repaired: false,
    };
  }

  const conflictReason = existingPeriod.status !== BillingPeriodStatus.OPEN
    ? "CLOSED_PERIOD"
    : existingPeriod.subscriptionId !== input.subscriptionId
      ? "SUBSCRIPTION_MISMATCH"
      : existingPeriod.shopifyPlanHandleSnapshot !== null &&
          existingPeriod.shopifyPlanHandleSnapshot !== input.providerPlanHandle
        ? "HANDLE_MISMATCH"
        : existingPeriod.planId !== null && existingPeriod.planId !== input.plan.id
          ? "PLAN_MISMATCH"
          : existingPeriod.planNameSnapshot !== null && existingPeriod.planNameSnapshot !== input.plan.name
            ? "PLAN_NAME_MISMATCH"
            : existingPeriod.planKindSnapshot !== null && existingPeriod.planKindSnapshot !== input.plan.kind
              ? "PLAN_KIND_MISMATCH"
              : existingPeriod.includedRecoveryCreditsGranted !== null &&
                  existingPeriod.includedRecoveryCreditsGranted !== expectedGrant
                ? "INCLUDED_GRANT_MISMATCH"
                : null;

  if (conflictReason) {
    return {
      kind: "CONFLICT",
      billingPeriodId: existingPeriod.id,
      reason: conflictReason,
    };
  }

  const includedCounter = await transaction.billingPeriodEntitlementCounter.findUnique({
    where: {
      billingPeriodId_counter: {
        billingPeriodId: existingPeriod.id,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
      },
    },
  });

  if (input.plan.kind === BillingPlanKind.FREE && includedCounter) {
    return {
      kind: "CONFLICT",
      billingPeriodId: existingPeriod.id,
      reason: "FREE_INCLUDED_COUNTER_PRESENT",
    };
  }

  if (input.plan.kind === BillingPlanKind.PAID_METERED && includedCounter && (
    includedCounter.shopId !== input.shopId ||
    includedCounter.grantedQuantity !== expectedGrant ||
    !isSafeNonNegativeInteger(includedCounter.grantedQuantity) ||
    !isSafeNonNegativeInteger(includedCounter.committedQuantity) ||
    !isSafeNonNegativeInteger(includedCounter.reservedQuantity) ||
    !isSafeNonNegativeInteger(includedCounter.forfeitedQuantity) ||
    includedCounter.currentAllowanceQuantity !== null ||
    includedCounter.committedQuantity + includedCounter.reservedQuantity + includedCounter.forfeitedQuantity > expectedGrant
  )) {
    return {
      kind: "CONFLICT",
      billingPeriodId: existingPeriod.id,
      reason: "PAID_COUNTER_MISMATCH",
    };
  }

  const repaired = existingPeriod.planId === null ||
    existingPeriod.shopifyPlanHandleSnapshot === null ||
    existingPeriod.planNameSnapshot === null ||
    existingPeriod.planKindSnapshot === null ||
    existingPeriod.includedRecoveryCreditsGranted !== expectedGrant;
  const repairedPeriod = await transaction.billingPeriod.update({
    where: { id: existingPeriod.id },
    data: {
      planId: input.plan.id,
      shopifyPlanHandleSnapshot: input.providerPlanHandle,
      planNameSnapshot: input.plan.name,
      planKindSnapshot: input.plan.kind,
      includedRecoveryCreditsGranted: expectedGrant,
      status: BillingPeriodStatus.OPEN,
    },
  });

  let counterRepaired = false;
  if (input.plan.kind === BillingPlanKind.PAID_METERED && !includedCounter) {
    await transaction.billingPeriodEntitlementCounter.create({
      data: {
        shopId: input.shopId,
        billingPeriodId: repairedPeriod.id,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
        grantedQuantity: expectedGrant as number,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
        currentAllowanceQuantity: null,
      },
    });
    counterRepaired = true;
  }

  return {
    kind: "READY",
    billingPeriodId: repairedPeriod.id,
    repaired: repaired || counterRepaired,
  };
}

export function deriveBillingPeriodPhase(
  periodEnd: Date | null,
  now = new Date(),
): BillingPeriodPhase | null {
  if (!periodEnd) return null;
  const drainStart = periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS;
  if (now.getTime() < drainStart) return "ACTIVE";
  if (now.getTime() < periodEnd.getTime()) return "DRAINING";
  return "RECONCILING";
}

export function isSafeNonNegativeInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}