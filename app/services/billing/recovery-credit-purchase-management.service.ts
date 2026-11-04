import {
  EntitlementCounter,
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
  type PrismaClient,
} from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import { logBillingBoundaryFailure } from "./providers/shopify-billing-diagnostics.server";
import {
  matchesRecoveryCreditProviderContext, readRecoveryCreditProviderObservation,
  type RecoveryCreditLocalContext,
} from "./recovery-credit-provider-context.server";

import prisma from "../../db.server";
import type { BillingProvider } from "./billing.types";
import { ShopifyBillingProvider } from "./providers/shopify-billing.provider";

const managementLogger = createLogger({
  serviceName: "moda-interact", environment: resolveDeploymentEnvironmentName(),
});
const refundSummarySelect = {
  status: true, reason: true, finalCreditQuantity: true,
  expectedProviderAmount: true, expectedProviderCurrency: true,
  createdAt: true, completedAt: true, providerActionKind: true,
} satisfies Prisma.RecoveryCreditRefundSelect;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_BATCH_SIZE = 20;
const MAX_RETRIES = 3;
const SHOPIFY_BILLING_PROVIDER = "SHOPIFY";
const LIVE_REFUND_STATUSES = [
  RecoveryCreditRefundStatus.REQUESTED,
  RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
  RecoveryCreditRefundStatus.NEEDS_ATTENTION,
] as const;

type Database = PrismaClient;

type PurchaseRow = {
  id: string;
  shopId: string;
  provider: string;
  status: RecoveryCreditPurchaseStatus;
  createdAt: Date;
  activatedAt: Date | null;
  creditsGranted: number;
  currentAmount: number;
  reservedAmount: number;
  version: number;
  billingPeriodId: string | null;
  shopifyPlanHandleSnapshot: string | null;
  shopifyEventHandleSnapshot: string | null;
  providerSubscriptionIdSnapshot: string | null;
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
  }>;
};

type ShopifyPurchaseRow = PurchaseRow & {
  provider: "SHOPIFY";
  billingPeriodId: string;
  shopifyPlanHandleSnapshot: string;
  shopifyEventHandleSnapshot: string;
  providerSubscriptionIdSnapshot: string;
};

type ShopifyRefundPurchaseRow = ShopifyPurchaseRow & {
  providerPurchaseCurrency: string;
};

function nonBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireShopifyPurchaseEvidence<T extends PurchaseRow>(
  purchase: T,
): T & ShopifyPurchaseRow {
  if (
    purchase.provider !== SHOPIFY_BILLING_PROVIDER ||
    !nonBlank(purchase.billingPeriodId) ||
    !nonBlank(purchase.shopifyPlanHandleSnapshot) ||
    !nonBlank(purchase.shopifyEventHandleSnapshot) ||
    !nonBlank(purchase.providerSubscriptionIdSnapshot)
  ) {
    throw new Error("Shopify recovery credit purchase evidence is invalid.");
  }
  return purchase as T & ShopifyPurchaseRow;
}

function hasShopifyRefundEvidence(
  purchase: PurchaseRow,
): purchase is ShopifyRefundPurchaseRow {
  return (
    purchase.provider === SHOPIFY_BILLING_PROVIDER &&
    nonBlank(purchase.billingPeriodId) &&
    nonBlank(purchase.shopifyPlanHandleSnapshot) &&
    nonBlank(purchase.shopifyEventHandleSnapshot) &&
    nonBlank(purchase.providerSubscriptionIdSnapshot) &&
    nonBlank(purchase.providerPurchaseCurrency)
  );
}

export type PurchaseHistoryItem = {
  id: string;
  status: RecoveryCreditPurchaseStatus;
  createdAt: string;
  activatedAt: string | null;
  creditsGranted: number;
  currentAmount: number;
  reservedAmount: number;
  availableAmount: number;
  heldForRefundAmount: number;
  refundEligible: boolean | null;
  refundUnavailableReason: "ZERO_VALUE" | "PROVIDER_CONTEXT" | null;
  planName: string;
  planHandle: string;
  eventHandle: string;
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
  | "ZERO_VALUE_NOT_REFUNDABLE"
  | "NOT_ACTIVE"
  | "ALREADY_WITHDRAWN"
  | "ALREADY_REFUNDED"
  | "COMPLETED"
  | "NOT_FOUND"
  | "CROSS_SHOP"
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
  shopifyPartnerDevelopment?: boolean;
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
  };
}

function historyItem(
  purchase: ShopifyPurchaseRow,
  refundEligible: boolean | null = null,
  refundUnavailableReason: PurchaseHistoryItem["refundUnavailableReason"] = null,
  completedRefund?: PurchaseRow["refunds"][number],
): PurchaseHistoryItem {
  const unreservedAmount = Math.max(
    purchase.currentAmount - purchase.reservedAmount,
    0,
  );

  return {
    id: purchase.id,
    status: purchase.status,
    createdAt: purchase.createdAt.toISOString(),
    activatedAt: purchase.activatedAt?.toISOString() ?? null,
    creditsGranted: purchase.creditsGranted,
    currentAmount: purchase.currentAmount,
    reservedAmount: purchase.reservedAmount,
    availableAmount:
      purchase.status === RecoveryCreditPurchaseStatus.ACTIVE
        ? unreservedAmount
        : 0,
    heldForRefundAmount:
      purchase.status === RecoveryCreditPurchaseStatus.WITHDRAWN
        ? unreservedAmount
        : 0,
    refundEligible,
    refundUnavailableReason,
    planName: purchase.plan?.name ?? purchase.shopifyPlanHandleSnapshot,
    planHandle: purchase.shopifyPlanHandleSnapshot,
    eventHandle: purchase.shopifyEventHandleSnapshot,
    originalProviderPurchase:
      purchase.providerPurchaseAmount == null ||
      !purchase.providerPurchaseCurrency
        ? null
        : {
            amount: String(purchase.providerPurchaseAmount),
            currency: purchase.providerPurchaseCurrency,
          },
    latestRefund: refundSummary(purchase.refunds[0]),
    completedRefund: refundSummary(completedRefund),
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

function hasRefundableValue(purchase: PurchaseRow, development?: boolean): boolean {
  const amount = purchase.providerPurchaseAmount == null ? null : Number(purchase.providerPurchaseAmount);
  return amount !== null && Number.isFinite(amount) && (amount > 0 || (amount === 0 && development === true));
}

function earlyRefundOutcome(purchase: PurchaseRow, input: RefundRequest): RefundOutcome | null {
  if (purchase.refunds[0] || purchase.status !== RecoveryCreditPurchaseStatus.ACTIVE)
    return outcomeForPurchase(purchase);
  const balances = {
    purchaseId: purchase.id, currentAmount: purchase.currentAmount,
    reservedAmount: purchase.reservedAmount,
    availableAmount: Math.max(purchase.currentAmount - purchase.reservedAmount, 0),
  };
  if (!nonBlank(input.shopifyShopId) || !hasShopifyRefundEvidence(purchase))
    return { ...balances, code: "REFUND_NOT_CURRENT_PROVIDER_CONTEXT" };
  if (balances.availableAmount < 1) return { ...balances, code: "REFUND_NOT_AVAILABLE" };
  const amount = purchase.providerPurchaseAmount == null ? null : Number(purchase.providerPurchaseAmount);
  if (amount === null || !Number.isFinite(amount) || amount < 0)
    return { ...balances, code: "REFUND_NOT_AVAILABLE" };
  if (amount === 0 && input.shopifyPartnerDevelopment !== true)
    return { ...balances, code: "ZERO_VALUE_NOT_REFUNDABLE" };
  return null;
}

export class RecoveryCreditPurchaseManagementService {
  constructor(
    private readonly database: Database = prisma,
    private readonly provider: BillingProvider = new ShopifyBillingProvider(),
    private readonly diagnostics: StructuredLogger = managementLogger,
  ) {}

  async listPurchaseHistory(input: {
    shopId: string;
    shopifyShopId?: string;
    shopifyPartnerDevelopment?: boolean;
    page?: number;
    pageSize?: number;
    status?: RecoveryCreditPurchaseStatus;
  }): Promise<PurchaseHistoryPage> {
    let stage = "read_page_and_count";
    try {
      const requestedPage = pageNumber(input.page);
      const size = pageSize(input.pageSize);
      const where: Prisma.RecoveryCreditPurchaseWhereInput = {
        shopId: input.shopId, provider: SHOPIFY_BILLING_PROVIDER,
        ...(input.status ? { status: input.status } : {}),
      };
      const findPurchases = (pageToRead: number) =>
        this.database.recoveryCreditPurchase.findMany({
          where, skip: (pageToRead - 1) * size, take: size,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: {
            plan: { select: { name: true, shopifyPlanHandle: true } },
            refunds: {
              where: { provider: SHOPIFY_BILLING_PROVIDER },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
              select: refundSummarySelect,
            },
          },
        });
      const [total, requestedPurchases] = await Promise.all([
        this.database.recoveryCreditPurchase.count({ where }), findPurchases(requestedPage),
      ]);
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / size)));
      const rows = page === requestedPage ? requestedPurchases : await findPurchases(page);
      const purchases = rows.map(requireShopifyPurchaseEvidence);
      stage = "read_completed_summary";
      const completed = purchases.length ? await this.database.recoveryCreditPurchase.findMany({
        where: { shopId: input.shopId, provider: SHOPIFY_BILLING_PROVIDER,
          id: { in: purchases.map(purchase => purchase.id) } },
        select: {
          id: true,
          refunds: {
            where: { provider: SHOPIFY_BILLING_PROVIDER, status: RecoveryCreditRefundStatus.COMPLETED },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
            select: refundSummarySelect,
          },
        },
      }) : [];
      const completedById = new Map(completed.map(purchase => [purchase.id, purchase.refunds[0]]));
      const needsVerification = Boolean(input.shopifyShopId) && purchases.some(purchase =>
        purchase.status === RecoveryCreditPurchaseStatus.ACTIVE &&
        hasRefundableValue(purchase, input.shopifyPartnerDevelopment));
      let local: RecoveryCreditLocalContext | undefined;
      let observed: Awaited<ReturnType<typeof readRecoveryCreditProviderObservation>> | undefined;
      if (needsVerification) {
        stage = "read_local_context";
        local = await this.readLocalContext(this.database, input.shopId);
        stage = "read_provider_context";
        observed = await readRecoveryCreditProviderObservation(this.provider, input.shopifyShopId!);
      }
      return {
        page, pageSize: size, total,
        purchases: purchases.map(purchase => {
          const completion = completedById.get(purchase.id);
          if (!input.shopifyShopId || purchase.status !== RecoveryCreditPurchaseStatus.ACTIVE)
            return historyItem(purchase, null, null, completion);
          if (!hasRefundableValue(purchase, input.shopifyPartnerDevelopment))
            return historyItem(purchase, false, "ZERO_VALUE", completion);
          const eligible = matchesRecoveryCreditProviderContext(purchase, local!, observed!);
          return historyItem(purchase, eligible, eligible ? null : "PROVIDER_CONTEXT", completion);
        }),
      };
    } catch (error) {
      logBillingBoundaryFailure({
        event: "shopify.billing.recovery_credit_history_failed", operation: "list_purchase_history",
        stage, shopId: input.shopId, error,
      }, this.diagnostics);
      throw error;
    }
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
              await transaction.recoveryCreditPurchase.findFirst({
                where: {
                  id: input.purchaseId,
                  shopId: input.shopId,
                  provider: SHOPIFY_BILLING_PROVIDER,
                },
                include: {
                  refunds: {
                    where: {
                      provider: SHOPIFY_BILLING_PROVIDER,
                      status: { in: [...LIVE_REFUND_STATUSES] },
                    },
                    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                    take: 1,
                  },
                },
              });
            if (!purchase)
              return { purchaseId: input.purchaseId, code: "NOT_FOUND" };
            const refund = purchase.refunds[0];
            if (
              purchase.status !== RecoveryCreditPurchaseStatus.WITHDRAWN ||
              !refund ||
              refund.status !== RecoveryCreditRefundStatus.REQUESTED ||
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
                    provider: SHOPIFY_BILLING_PROVIDER,
                    version: refund.version,
                    status: RecoveryCreditRefundStatus.REQUESTED,
                    providerReference: null,
                    providerActionKind: null,
                    providerConfirmedAt: null,
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
                    provider: SHOPIFY_BILLING_PROVIDER,
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
                  provider: SHOPIFY_BILLING_PROVIDER,
                  version: refund.version,
                  status: RecoveryCreditRefundStatus.REQUESTED,
                  providerReference: null,
                  providerActionKind: null,
                  providerConfirmedAt: null,
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
                  provider: SHOPIFY_BILLING_PROVIDER,
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
        const retrying = retryable(error) && attempt < MAX_RETRIES - 1;
        this.recordMutationFailure("reactivate_refund", "reactivation_transaction", input, error, attempt, retrying);
        if (!retrying) throw error;
      }
    }
    throw new Error("Recovery credit reactivation unavailable.");
  }

  private async requestRefundWithRetry(
    input: RefundRequest,
  ): Promise<RefundOutcome> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      let stage = "refund_preflight_read";
      try {
        const preflight = await this.readRefundPurchase(this.database, input);
        if (!preflight) return { purchaseId: input.purchaseId, code: "NOT_FOUND" };
        const early = earlyRefundOutcome(preflight, input);
        if (early) return early;
        stage = "refund_provider_preflight";
        const observed = await readRecoveryCreditProviderObservation(this.provider, input.shopifyShopId);
        stage = "refund_transaction";
        return await this.database.$transaction(
          async (transaction) => {
            const purchase =
              await transaction.recoveryCreditPurchase.findFirst({
                where: {
                  id: input.purchaseId,
                  shopId: input.shopId,
                  provider: SHOPIFY_BILLING_PROVIDER,
                },
                include: {
                  refunds: {
                    where: {
                      provider: SHOPIFY_BILLING_PROVIDER,
                      status: { in: [...LIVE_REFUND_STATUSES] },
                    },
                    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                    take: 1,
                  },
                },
              });
            if (!purchase)
              return { purchaseId: input.purchaseId, code: "NOT_FOUND" };
            const early = earlyRefundOutcome(purchase, input);
            if (early) return early;
            const availableAmount = Math.max(purchase.currentAmount - purchase.reservedAmount, 0);
            const local = await this.readLocalContext(transaction, input.shopId);
            if (!matchesRecoveryCreditProviderContext(purchase, local, observed)) {
              return {
                purchaseId: purchase.id, code: "REFUND_NOT_CURRENT_PROVIDER_CONTEXT",
                currentAmount: purchase.currentAmount, reservedAmount: purchase.reservedAmount, availableAmount,
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
                provider: SHOPIFY_BILLING_PROVIDER,
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
                shopifyPartnerDevelopmentSnapshot:
                  input.shopifyPartnerDevelopment === true,
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
                  provider: SHOPIFY_BILLING_PROVIDER,
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
        if (retryable(error) && attempt < MAX_RETRIES - 1) {
          this.recordMutationFailure("request_refund", stage, input, error, attempt, true);
          continue;
        }
        if (isUniqueConflict(error)) {
          const existing = await this.database.recoveryCreditRefund.findFirst({
            where: {
              shopId: input.shopId,
              provider: SHOPIFY_BILLING_PROVIDER,
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
                    where: {
                      provider: SHOPIFY_BILLING_PROVIDER,
                      status: { in: [...LIVE_REFUND_STATUSES] },
                    },
                    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                    take: 1,
                  },
                },
              },
            },
          }).catch(recoveryError => {
            this.recordMutationFailure("request_refund", "read_refund_receipt", input, recoveryError, attempt, false);
            throw recoveryError;
          });
          if (
            existing?.provider === SHOPIFY_BILLING_PROVIDER &&
            existing.purchase?.shopId === input.shopId &&
            existing.purchase.provider === SHOPIFY_BILLING_PROVIDER
          ) {
            return outcomeForPurchase(existing.purchase as PurchaseRow);
          }

          const purchase = await this.database.recoveryCreditPurchase.findFirst(
            {
              where: {
                id: input.purchaseId,
                shopId: input.shopId,
                provider: SHOPIFY_BILLING_PROVIDER,
              },
              include: {
                refunds: {
                  where: {
                    provider: SHOPIFY_BILLING_PROVIDER,
                    status: { in: [...LIVE_REFUND_STATUSES] },
                  },
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  take: 1,
                },
              },
            },
          ).catch(recoveryError => {
            this.recordMutationFailure("request_refund", "read_refund_replay", input, recoveryError, attempt, false);
            throw recoveryError;
          });
          if (purchase?.refunds[0])
            return outcomeForPurchase(purchase as PurchaseRow);
        }
        this.recordMutationFailure("request_refund", stage, input, error, attempt, false);
        throw error;
      }
    }
    throw new Error("Recovery credit refund unavailable.");
  }

  private async readRefundPurchase(
    database: Pick<Prisma.TransactionClient, "recoveryCreditPurchase">,
    input: { shopId: string; purchaseId: string },
  ) {
    return database.recoveryCreditPurchase.findFirst({
      where: { id: input.purchaseId, shopId: input.shopId, provider: SHOPIFY_BILLING_PROVIDER },
      include: { refunds: {
        where: { provider: SHOPIFY_BILLING_PROVIDER, status: { in: [...LIVE_REFUND_STATUSES] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
      } },
    });
  }

  private async readLocalContext(
    database: Pick<Prisma.TransactionClient, "shop" | "subscription">,
    shopId: string,
  ): Promise<RecoveryCreditLocalContext> {
    const [shop, subscription] = await Promise.all([
      database.shop.findUnique({
        where: { id: shopId },
        select: { id: true, platform: true, status: true, shopifyShopId: true },
      }),
      database.subscription.findUnique({
        where: { shopId },
        select: { shopId: true, billingPeriodId: true,
          billingPeriod: { select: { id: true, periodStart: true, periodEnd: true } } },
      }),
    ]);
    return { shop, subscription };
  }

  private recordMutationFailure(
    operation: "request_refund" | "reactivate_refund", stage: string,
    input: { shopId: string; purchaseId: string }, error: unknown, attempt: number, retrying: boolean,
  ) {
    logBillingBoundaryFailure({
      event: retrying ? "shopify.billing.recovery_credit_retry" : "shopify.billing.recovery_credit_mutation_failed",
      operation, stage, shopId: input.shopId,
      identities: { purchaseId: input.purchaseId, attempt: String(attempt + 1) }, error,
    }, retrying ? { ...this.diagnostics, error: this.diagnostics.warn } : this.diagnostics);
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
