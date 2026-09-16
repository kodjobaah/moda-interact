import {
  EntitlementCounter,
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
  type PrismaClient,
} from "@prisma/client";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";

import prisma from "../../db.server";
import type { BillingProvider } from "./billing.types";
import { ShopifyBillingProvider } from "./providers/shopify-billing.provider";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_BATCH_SIZE = 20;
const MAX_RETRIES = 3;
const LIVE_REFUND_STATUSES = [
  RecoveryCreditRefundStatus.REQUESTED,
  RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
  RecoveryCreditRefundStatus.NEEDS_ATTENTION,
] as const;

type Database = PrismaClient;

type PurchaseRow = {
  id: string;
  shopId: string;
  status: RecoveryCreditPurchaseStatus;
  createdAt: Date;
  activatedAt: Date | null;
  creditsGranted: number;
  currentAmount: number;
  reservedAmount: number;
  version: number;
  billingPeriodId: string;
  shopifyPlanHandleSnapshot: string;
  shopifyEventHandleSnapshot: string;
  providerSubscriptionIdSnapshot: string;
  plan?: { name: string; shopifyPlanHandle: string };
  providerPurchaseAmount: unknown;
  providerPurchaseCurrency: string | null;
  refunds: Array<{
    status: RecoveryCreditRefundStatus;
    reason: string | null;
    finalCreditQuantity: number | null;
    expectedProviderAmount: unknown;
    expectedProviderCurrency: string | null;
    createdAt: Date;
    completedAt: Date | null;
    providerActionKind: string | null;
    automaticCorrectionUsageEventId: string | null;
  }>;
};

export type PurchaseHistoryItem = {
  id: string;
  status: RecoveryCreditPurchaseStatus;
  createdAt: string;
  activatedAt: string | null;
  creditsGranted: number;
  currentAmount: number;
  reservedAmount: number;
  availableAmount: number;
  refundEligible: boolean | null;
  planName: string;
  planHandle: string;
  originalProviderPurchase: {
    amount: string;
    currency: string;
  } | null;
  latestRefund: RefundSummary | null;
  completedRefund: RefundSummary | null;
};

type RefundSummary = {
  status: RecoveryCreditRefundStatus;
  reason: string | null;
  finalCreditQuantity: number | null;
  expectedProviderAmount: string | null;
  expectedProviderCurrency: string | null;
  createdAt: string;
  completedAt: string | null;
  automaticCorrectionUsageEventId: string | null;
};

export type PurchaseHistoryPage = {
  page: number;
  pageSize: number;
  total: number;
  purchases: PurchaseHistoryItem[];
};

export type RefundOutcomeCode =
  | "REQUESTED"
  | "REFUND_NOT_AVAILABLE"
  | "NOT_ACTIVE"
  | "ALREADY_WITHDRAWN"
  | "ALREADY_REFUNDED"
  | "COMPLETED"
  | "NOT_FOUND"
  | "CROSS_SHOP"
  | "METER_BUSY"
  | "REFUND_NOT_CURRENT_PROVIDER_CONTEXT";

export type RefundOutcome = {
  purchaseId: string;
  code: RefundOutcomeCode;
  currentAmount?: number;
  reservedAmount?: number;
  availableAmount?: number;
};

export type ReactivationOutcome =
  | {
      purchaseId: string;
      code: "REACTIVATED";
      currentAmount: number;
      reservedAmount: number;
    }
  | { purchaseId: string; code: "COMPLETED_NO_CREDITS" }
  | { purchaseId: string; code: "REACTIVATION_NOT_AVAILABLE" }
  | { purchaseId: string; code: "NOT_FOUND" };

type RefundRequest = {
  shopId: string;
  shopifyShopId: string;
  purchaseId: string;
  requestId: string;
  shopifyUserId?: string | null;
  displayedAvailableAmount?: number;
  quantity?: number;
  amount?: string;
  currency?: string;
};

type BatchRefundRequest = Omit<RefundRequest, "purchaseId"> & {
  purchaseIds: string[];
};

function retryable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  );
}

function pageNumber(value: number | undefined): number {
  return Number.isInteger(value) && value && value > 0 ? value : 1;
}

function pageSize(value: number | undefined): number {
  return Math.min(
    Math.max(Number.isInteger(value) && value ? value : DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
}

function decimalString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function refundSummary(
  refund: PurchaseRow["refunds"][number] | undefined,
): RefundSummary | null {
  if (!refund) return null;
  return {
    status: refund.status,
    reason: refund.reason,
    finalCreditQuantity: refund.finalCreditQuantity,
    expectedProviderAmount: decimalString(refund.expectedProviderAmount),
    expectedProviderCurrency: refund.expectedProviderCurrency,
    createdAt: refund.createdAt.toISOString(),
    completedAt: refund.completedAt?.toISOString() ?? null,
    automaticCorrectionUsageEventId: refund.automaticCorrectionUsageEventId,
  };
}

function historyItem(
  purchase: PurchaseRow,
  refundEligible: boolean | null = null,
): PurchaseHistoryItem {
  return {
    id: purchase.id,
    status: purchase.status,
    createdAt: purchase.createdAt.toISOString(),
    activatedAt: purchase.activatedAt?.toISOString() ?? null,
    creditsGranted: purchase.creditsGranted,
    currentAmount: purchase.currentAmount,
    reservedAmount: purchase.reservedAmount,
    availableAmount: Math.max(
      purchase.currentAmount - purchase.reservedAmount,
      0,
    ),
    refundEligible,
    planName: purchase.plan?.name ?? purchase.shopifyPlanHandleSnapshot,
    planHandle: purchase.shopifyPlanHandleSnapshot,
    originalProviderPurchase:
      purchase.providerPurchaseAmount == null ||
      !purchase.providerPurchaseCurrency
        ? null
        : {
            amount: String(purchase.providerPurchaseAmount),
            currency: purchase.providerPurchaseCurrency,
          },
    latestRefund: refundSummary(purchase.refunds[0]),
    completedRefund: refundSummary(
      purchase.refunds.find(
        (refund) => refund.status === RecoveryCreditRefundStatus.COMPLETED,
      ),
    ),
  };
}

function requestKey(
  shopId: string,
  requestId: string,
  purchaseId: string,
): string {
  return `merchant-ui:recovery-credit-refund:${shopId}:${requestId}:${purchaseId}`;
}

function outcomeForExistingRefund(
  purchase: PurchaseRow,
  refundStatus: RecoveryCreditRefundStatus,
): RefundOutcomeCode {
  if (refundStatus === RecoveryCreditRefundStatus.REQUESTED) return "REQUESTED";
  if (
    refundStatus === RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED ||
    refundStatus === RecoveryCreditRefundStatus.NEEDS_ATTENTION
  )
    return "ALREADY_WITHDRAWN";
  return purchase.status === RecoveryCreditPurchaseStatus.REFUNDED
    ? "ALREADY_REFUNDED"
    : "ALREADY_WITHDRAWN";
}

function outcomeForPurchase(purchase: PurchaseRow): RefundOutcome {
  const availableAmount = Math.max(
    purchase.currentAmount - purchase.reservedAmount,
    0,
  );
  const liveRefund = purchase.refunds[0];
  if (liveRefund) {
    return {
      purchaseId: purchase.id,
      code: outcomeForExistingRefund(purchase, liveRefund.status),
      currentAmount: purchase.currentAmount,
      reservedAmount: purchase.reservedAmount,
      availableAmount,
    };
  }
  const code =
    purchase.status === RecoveryCreditPurchaseStatus.REFUNDED
      ? "ALREADY_REFUNDED"
      : purchase.status === RecoveryCreditPurchaseStatus.COMPLETED
        ? "COMPLETED"
        : "NOT_ACTIVE";
  return {
    purchaseId: purchase.id,
    code,
    currentAmount: purchase.currentAmount,
    reservedAmount: purchase.reservedAmount,
    availableAmount,
  };
}

export class RecoveryCreditPurchaseManagementService {
  constructor(
    private readonly database: Database = prisma,
    private readonly provider: BillingProvider = new ShopifyBillingProvider(),
  ) {}

  async listPurchaseHistory(input: {
    shopId: string;
    shopifyShopId?: string;
    page?: number;
    pageSize?: number;
    status?: RecoveryCreditPurchaseStatus;
  }): Promise<PurchaseHistoryPage> {
    const page = pageNumber(input.page);
    const size = pageSize(input.pageSize);
    const where: Prisma.RecoveryCreditPurchaseWhereInput = {
      shopId: input.shopId,
      ...(input.status ? { status: input.status } : {}),
    };
    const [total, purchases] = await Promise.all([
      this.database.recoveryCreditPurchase.count({ where }),
      this.database.recoveryCreditPurchase.findMany({
        where,
        skip: (page - 1) * size,
        take: size,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          plan: { select: { name: true, shopifyPlanHandle: true } },
          refunds: {
            orderBy: { createdAt: "desc" },
            select: {
              status: true,
              reason: true,
              finalCreditQuantity: true,
              expectedProviderAmount: true,
              expectedProviderCurrency: true,
              createdAt: true,
              completedAt: true,
              providerActionKind: true,
              automaticCorrectionUsageEventId: true,
            },
          },
        },
      }),
    ]);
    return {
      page,
      pageSize: size,
      total,
      purchases: await Promise.all(
        purchases.map(async (purchase) =>
          historyItem(
            purchase,
            input.shopifyShopId &&
              purchase.status === RecoveryCreditPurchaseStatus.ACTIVE
              ? await this.isCurrentProviderContext(
                  purchase,
                  input.shopifyShopId,
                )
              : null,
          ),
        ),
      ),
    };
  }

  async requestRefund(
    input: RefundRequest,
  ): Promise<RefundOutcome> {
    return this.requestRefundWithRetry(input);
  }

  async requestRefundBatch(
    input: BatchRefundRequest,
  ): Promise<RefundOutcome[]> {
    const uniquePurchaseIds = [...new Set(input.purchaseIds)].slice(
      0,
      MAX_BATCH_SIZE,
    );
    const outcomes: RefundOutcome[] = [];
    for (const purchaseId of uniquePurchaseIds) {
      outcomes.push(await this.requestRefund({ ...input, purchaseId }));
    }
    return outcomes;
  }

  async reactivateRefund(input: {
    shopId: string;
    purchaseId: string;
  }): Promise<ReactivationOutcome> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        return await this.database.$transaction(
          async (transaction) => {
            const purchase =
              await transaction.recoveryCreditPurchase.findUnique({
                where: { id: input.purchaseId },
                include: {
                  refunds: {
                    where: { status: { in: [...LIVE_REFUND_STATUSES] } },
                    orderBy: { createdAt: "desc" },
                    take: 1,
                  },
                },
              });
            if (!purchase || purchase.shopId !== input.shopId)
              return { purchaseId: input.purchaseId, code: "NOT_FOUND" };
            const refund = purchase.refunds[0];
            if (
              purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN ||
              !refund ||
              refund.status !== RecoveryCreditRefundStatus.REQUESTED ||
              refund.automaticCorrectionUsageEventId !== null ||
              refund.providerReference ||
              refund.providerActionKind ||
              refund.providerConfirmedAt
            ) {
              return {
                purchaseId: input.purchaseId,
                code: "REACTIVATION_NOT_AVAILABLE",
              };
            }

            if (purchase.currentAmount === 0) {
              const refundUpdate =
                await transaction.recoveryCreditRefund.updateMany({
                  where: {
                    id: refund.id,
                    purchaseId: purchase.id,
                    version: refund.version,
                    status: RecoveryCreditRefundStatus.REQUESTED,
                    providerReference: null,
                    providerActionKind: null,
                    providerConfirmedAt: null,
                    automaticCorrectionUsageEventId: null,
                  },
                  data: {
                    status: RecoveryCreditRefundStatus.CANCELLED,
                    reason: "NO_CREDITS_REMAINING",
                    version: { increment: 1 },
                  },
                });
              const purchaseUpdate =
                await transaction.recoveryCreditPurchase.updateMany({
                  where: {
                    id: purchase.id,
                    shopId: input.shopId,
                    status: RecoveryCreditPurchaseStatus.WITHDRAWN,
                    version: purchase.version,
                    currentAmount: 0,
                    reservedAmount: 0,
                  },
                  data: {
                    status: RecoveryCreditPurchaseStatus.COMPLETED,
                    version: { increment: 1 },
                  },
                });
              if (refundUpdate.count !== 1 || purchaseUpdate.count !== 1)
                throw new Prisma.PrismaClientKnownRequestError(
                  "reactivation CAS lost",
                  { code: "P2034", clientVersion: "6" },
                );
              return {
                purchaseId: input.purchaseId,
                code: "COMPLETED_NO_CREDITS",
              };
            }

            const heldAvailable = Math.max(
              purchase.currentAmount - purchase.reservedAmount,
              0,
            );
            const refundUpdate =
              await transaction.recoveryCreditRefund.updateMany({
                where: {
                  id: refund.id,
                  purchaseId: purchase.id,
                  version: refund.version,
                  status: RecoveryCreditRefundStatus.REQUESTED,
                  providerReference: null,
                  providerActionKind: null,
                  providerConfirmedAt: null,
                  automaticCorrectionUsageEventId: null,
                },
                data: {
                  status: RecoveryCreditRefundStatus.CANCELLED,
                  reason: "MERCHANT_REACTIVATED",
                  version: { increment: 1 },
                },
              });
            const purchaseUpdate =
              await transaction.recoveryCreditPurchase.updateMany({
                where: {
                  id: purchase.id,
                  shopId: input.shopId,
                  status: RecoveryCreditPurchaseStatus.WITHDRAWN,
                  version: purchase.version,
                  currentAmount: purchase.currentAmount,
                  reservedAmount: purchase.reservedAmount,
                },
                data: {
                  status: RecoveryCreditPurchaseStatus.ACTIVE,
                  version: { increment: 1 },
                },
              });
            const aggregate =
              await transaction.shopEntitlementCounter.findUnique({
                where: {
                  shopId_counter: {
                    shopId: input.shopId,
                    counter: EntitlementCounter.PURCHASED_RECOVERY_CREDITS,
                  },
                },
              });
            const aggregateUpdate =
              aggregate && heldAvailable > 0
                ? await transaction.shopEntitlementCounter.updateMany({
                    where: {
                      id: aggregate.id,
                      version: aggregate.version,
                      refundingQuantity: aggregate.refundingQuantity,
                      reservedQuantity: aggregate.reservedQuantity,
                    },
                    data: {
                      refundingQuantity: { decrement: heldAvailable },
                      version: { increment: 1 },
                    },
                  })
                : { count: heldAvailable === 0 ? 1 : 0 };
            if (
              refundUpdate.count !== 1 ||
              purchaseUpdate.count !== 1 ||
              aggregateUpdate.count !== 1
            )
              throw new Prisma.PrismaClientKnownRequestError(
                "reactivation CAS lost",
                { code: "P2034", clientVersion: "6" },
              );
            return {
              purchaseId: input.purchaseId,
              code: "REACTIVATED",
              currentAmount: purchase.currentAmount,
              reservedAmount: purchase.reservedAmount,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (!retryable(error) || attempt === MAX_RETRIES - 1) throw error;
      }
    }
    throw new Error("Recovery credit reactivation unavailable.");
  }

  private async requestRefundWithRetry(
    input: RefundRequest,
  ): Promise<RefundOutcome> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        return await this.database.$transaction(
          async (transaction) => {
            const purchase =
              await transaction.recoveryCreditPurchase.findUnique({
                where: { id: input.purchaseId },
                include: {
                  refunds: {
                    where: { status: { in: [...LIVE_REFUND_STATUSES] } },
                    orderBy: { createdAt: "desc" },
                    take: 1,
                  },
                },
              });
            if (!purchase)
              return { purchaseId: input.purchaseId, code: "NOT_FOUND" };
            if (purchase.shopId !== input.shopId)
              return { purchaseId: input.purchaseId, code: "NOT_FOUND" };
            const liveRefund = purchase.refunds[0];
            if (liveRefund) {
              return {
                purchaseId: input.purchaseId,
                code: outcomeForExistingRefund(purchase, liveRefund.status),
                currentAmount: purchase.currentAmount,
                reservedAmount: purchase.reservedAmount,
                availableAmount: Math.max(
                  purchase.currentAmount - purchase.reservedAmount,
                  0,
                ),
              };
            }
            if (purchase.status !== RecoveryCreditPurchaseStatus.ACTIVE) {
              const code =
                purchase.status === RecoveryCreditPurchaseStatus.REFUNDED
                  ? "ALREADY_REFUNDED"
                  : purchase.status === RecoveryCreditPurchaseStatus.COMPLETED
                    ? "COMPLETED"
                    : "NOT_ACTIVE";
              return {
                purchaseId: input.purchaseId,
                code,
                currentAmount: purchase.currentAmount,
                reservedAmount: purchase.reservedAmount,
                availableAmount: Math.max(
                  purchase.currentAmount - purchase.reservedAmount,
                  0,
                ),
              };
            }
            if (
              typeof input.shopifyShopId !== "string" ||
              !input.shopifyShopId.trim()
            )
              return {
                purchaseId: input.purchaseId,
                code: "REFUND_NOT_CURRENT_PROVIDER_CONTEXT",
                currentAmount: purchase.currentAmount,
                reservedAmount: purchase.reservedAmount,
                availableAmount: Math.max(
                  purchase.currentAmount - purchase.reservedAmount,
                  0,
                ),
              };
            const availableAmount = Math.max(
              purchase.currentAmount - purchase.reservedAmount,
              0,
            );
            if (availableAmount < 1)
              return {
                purchaseId: input.purchaseId,
                code: "REFUND_NOT_AVAILABLE",
                currentAmount: purchase.currentAmount,
                reservedAmount: purchase.reservedAmount,
                availableAmount,
              };
            if (
              purchase.providerPurchaseAmount == null ||
              Number(purchase.providerPurchaseAmount) <= 0
            )
              return {
                purchaseId: input.purchaseId,
                code: "REFUND_NOT_AVAILABLE",
                currentAmount: purchase.currentAmount,
                reservedAmount: purchase.reservedAmount,
                availableAmount,
              };
            if ("$queryRaw" in transaction && typeof transaction.$queryRaw === "function") {
              await transaction.$queryRaw(Prisma.sql`
                SELECT "id"
                FROM "billing"."Subscription"
                WHERE "shopId" = ${input.shopId}
                FOR UPDATE
              `);
            }
            const eventHandle = purchase.shopifyEventHandleSnapshot;
            const pendingPurchase = await transaction.recoveryCreditPurchase?.findFirst?.({
              where: {
                shopId: input.shopId,
                status: RecoveryCreditPurchaseStatus.REQUESTED,
                shopifyEventHandleSnapshot: eventHandle,
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: { id: true },
            });
            const competingRefund = await transaction.recoveryCreditRefund?.findFirst?.({
              where: {
                shopId: input.shopId,
                eventHandleSnapshot: eventHandle,
                status: { in: [...LIVE_REFUND_STATUSES] },
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: { id: true, purchaseId: true },
            });
            if (pendingPurchase || competingRefund) {
              return {
                purchaseId: input.purchaseId,
                code: "METER_BUSY",
                currentAmount: purchase.currentAmount,
                reservedAmount: purchase.reservedAmount,
                availableAmount,
              };
            }
            if (!(await this.isCurrentProviderContext(purchase, input.shopifyShopId))) {
              return {
                purchaseId: input.purchaseId,
                code: "REFUND_NOT_CURRENT_PROVIDER_CONTEXT",
                currentAmount: purchase.currentAmount,
                reservedAmount: purchase.reservedAmount,
                availableAmount,
              };
            }
            const aggregate =
              await transaction.shopEntitlementCounter.findUnique({
                where: {
                  shopId_counter: {
                    shopId: input.shopId,
                    counter: EntitlementCounter.PURCHASED_RECOVERY_CREDITS,
                  },
                },
              });
            if (!aggregate)
              throw new Error(
                "Purchased recovery-credit aggregate is missing.",
              );
            const now = new Date();
            await transaction.recoveryCreditRefund.create({
              data: {
                shopId: input.shopId,
                purchaseId: purchase.id,
                source: "MERCHANT_UI",
                requestedByShopifyUserId: input.shopifyUserId ?? null,
                purchaseCreditsGrantedSnapshot: purchase.creditsGranted,
                currentAmountAtRequestSnapshot: purchase.currentAmount,
                reservedAmountAtRequestSnapshot: purchase.reservedAmount,
                availableAmountAtRequestSnapshot: availableAmount,
                billingPeriodIdSnapshot: purchase.billingPeriodId,
                providerSubscriptionIdSnapshot:
                  purchase.providerSubscriptionIdSnapshot,
                planHandleSnapshot: purchase.shopifyPlanHandleSnapshot,
                eventHandleSnapshot: purchase.shopifyEventHandleSnapshot,
                purchaseProviderAmountSnapshot: purchase.providerPurchaseAmount,
                purchaseProviderCurrencySnapshot:
                  purchase.providerPurchaseCurrency,
                status: RecoveryCreditRefundStatus.REQUESTED,
                requestKey: requestKey(
                  input.shopId,
                  input.requestId,
                  input.purchaseId,
                ),
                holdAppliedAt: now,
              } as never,
            });
            const purchaseUpdate =
              await transaction.recoveryCreditPurchase.updateMany({
                where: {
                  id: purchase.id,
                  shopId: input.shopId,
                  status: RecoveryCreditPurchaseStatus.ACTIVE,
                  version: purchase.version,
                  currentAmount: purchase.currentAmount,
                  reservedAmount: purchase.reservedAmount,
                },
                data: {
                  status: RecoveryCreditPurchaseStatus.WITHDRAWN,
                  version: { increment: 1 },
                },
              });
            const aggregateUpdate =
              await transaction.shopEntitlementCounter.updateMany({
                where: {
                  id: aggregate.id,
                  version: aggregate.version,
                  refundingQuantity: aggregate.refundingQuantity,
                  reservedQuantity: aggregate.reservedQuantity,
                },
                data: {
                  refundingQuantity: { increment: availableAmount },
                  version: { increment: 1 },
                },
              });
            if (purchaseUpdate.count !== 1 || aggregateUpdate.count !== 1)
              throw new Prisma.PrismaClientKnownRequestError(
                "refund CAS lost",
                { code: "P2034", clientVersion: "6" },
              );
            return {
              purchaseId: input.purchaseId,
              code: "REQUESTED",
              currentAmount: purchase.currentAmount,
              reservedAmount: purchase.reservedAmount,
              availableAmount,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (retryable(error) && attempt < MAX_RETRIES - 1) continue;
        if (isUniqueConflict(error)) {
          const existing = await this.database.recoveryCreditRefund.findUnique({
            where: {
              requestKey: requestKey(
                input.shopId,
                input.requestId,
                input.purchaseId,
              ),
            },
            include: {
              purchase: {
                include: {
                  refunds: {
                    where: { status: { in: [...LIVE_REFUND_STATUSES] } },
                    orderBy: { createdAt: "desc" },
                    take: 1,
                  },
                },
              },
            },
          });
          if (existing?.purchase?.shopId === input.shopId) {
            return outcomeForPurchase(existing.purchase as PurchaseRow);
          }

          const purchase = await this.database.recoveryCreditPurchase.findFirst(
            {
              where: { id: input.purchaseId, shopId: input.shopId },
              include: {
                refunds: {
                  where: { status: { in: [...LIVE_REFUND_STATUSES] } },
                  orderBy: { createdAt: "desc" },
                  take: 1,
                },
              },
            },
          );
          if (purchase?.refunds[0])
            return outcomeForPurchase(purchase as PurchaseRow);
          throw error;
        }
        throw error;
      }
    }
    throw new Error("Recovery credit refund unavailable.");
  }

  private async isCurrentProviderContext(
    purchase: PurchaseRow & {
      billingPeriodId: string;
      providerSubscriptionIdSnapshot: string;
      shopifyEventHandleSnapshot: string;
    },
    shopifyShopId: string,
  ): Promise<boolean> {
    const [shop, subscription, providerSubscription] = await Promise.all([
      this.database.shop.findUnique({
        where: { id: purchase.shopId },
        select: { shopifyShopId: true },
      }),
      this.database.subscription.findUnique({
        where: { shopId: purchase.shopId },
        select: {
          billingPeriodId: true,
          billingPeriod: { select: { periodStart: true, periodEnd: true } },
        },
      }),
      this.provider.getActiveSubscription({ shopifyShopId }),
    ]);
    if (
      shop?.shopifyShopId !== shopifyShopId ||
      !subscription ||
      !providerSubscription ||
      providerSubscription.status !== "ACTIVE" &&
      providerSubscription.status !== "TRIALING"
    )
      return false;
    const providerIdentity = deriveShopifyProviderContextIdentity({
      providerSubscriptionId: providerSubscription.providerSubscriptionId,
      planHandle: providerSubscription.planHandle,
      currentPeriodStart: providerSubscription.currentPeriodStart,
      currentPeriodEnd: providerSubscription.currentPeriodEnd,
    });
    return (
      purchase.providerSubscriptionIdSnapshot === providerIdentity &&
      purchase.shopifyPlanHandleSnapshot === providerSubscription.planHandle &&
      purchase.billingPeriodId === subscription.billingPeriodId &&
      subscription.billingPeriod?.periodStart?.getTime() ===
        providerSubscription.currentPeriodStart?.getTime() &&
      subscription.billingPeriod?.periodEnd?.getTime() ===
        providerSubscription.currentPeriodEnd?.getTime() &&
      providerSubscription.usageEventHandles.includes(
        purchase.shopifyEventHandleSnapshot,
      )
    );
  }
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export const recoveryCreditPurchaseManagementService =
  new RecoveryCreditPurchaseManagementService();
