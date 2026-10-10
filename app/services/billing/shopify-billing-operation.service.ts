import { createHash, timingSafeEqual } from "node:crypto";

import {
  BillingOperationKind,
  BillingOperationState,
  MerchantPricingBillingPeriod,
  MerchantPricingPlanKind,
  MerchantPricingUsagePricingMode,
  ShopPlatform,
  type BillingOperation,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

export type ShopifyUsageEventQuote = Readonly<{
  id: string;
  pricingMode: MerchantPricingUsagePricingMode;
  currency: string;
  fixedUnitAmountMinor: number | null;
  tiers: ReadonlyArray<Readonly<{
    position: number;
    upTo: number | null;
    amountPerUnitMinor: number;
    flatAmountMinor: number;
  }>>;
}>;

type RecurringOperationKind = Exclude<BillingOperationKind, "ONE_TIME_CHARGE">;

type BillingOperationTransaction = Prisma.TransactionClient;

type PaidPlanQuote = Readonly<{
  id: string;
  recurringAmountMinor: number;
  currency: string;
  billingPeriod: MerchantPricingBillingPeriod;
}>;

const OPEN_OPERATION_STATES = [
  BillingOperationState.INITIATING,
  BillingOperationState.AWAITING_CONFIRMATION,
  BillingOperationState.OUTCOME_UNKNOWN,
] as const;

function nonBlank(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertCanonicalField(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      throw new TypeError("Shopify billing operation identity contains control characters.");
    }
  }
}

function operationRequestKey(kind: BillingOperationKind, fields: readonly string[]): string {
  for (const value of fields) assertCanonicalField(value);
  const digest = createHash("sha256")
    .update(`arch027-shopify-operation-key-v1\n${kind}\n${fields.join("\n")}\n`, "utf8")
    .digest("hex");
  return `shopify:${kind.toLowerCase()}:${digest}`;
}

export function shopifyRecurringRequestFingerprint(input: {
  kind: RecurringOperationKind;
  shopId: string;
  providerReference?: string | null;
  merchantPricingPlanId?: string | null;
  quotedAmountMinor?: number | null;
  quotedCurrency?: string | null;
  quotedBillingPeriod?: MerchantPricingBillingPeriod | null;
}): Buffer {
  assertCanonicalField(input.shopId);
  const fields = ["arch027-recurring-v1", input.kind, input.shopId];
  if (input.kind !== BillingOperationKind.CANCEL) {
    if (
      !input.merchantPricingPlanId ||
      !Number.isSafeInteger(input.quotedAmountMinor) ||
      (input.quotedAmountMinor ?? 0) <= 0 ||
      !input.quotedCurrency ||
      !input.quotedBillingPeriod
    ) {
      throw new TypeError("Shopify recurring billing operation quote is invalid.");
    }
    assertCanonicalField(input.merchantPricingPlanId);
    assertCanonicalField(String(input.quotedAmountMinor));
    assertCanonicalField(input.quotedCurrency);
    assertCanonicalField(input.quotedBillingPeriod);
    fields.push(
      input.merchantPricingPlanId,
      String(input.quotedAmountMinor),
      input.quotedCurrency,
      input.quotedBillingPeriod,
    );
  }
  if (input.kind !== BillingOperationKind.SUBSCRIPTION_CREATE) {
    const providerReference = nonBlank(input.providerReference);
    if (!providerReference) throw new TypeError("Shopify provider reference is required.");
    assertCanonicalField(providerReference);
    fields.splice(3, 0, providerReference);
  }
  return createHash("sha256").update(`${fields.join("\n")}\n`, "utf8").digest();
}

export function shopifyOneTimeChargeRequestFingerprint(input: {
  shopId: string;
  merchantPricingUsageEventId: string;
  quotedAmountMinor: number;
  quotedCurrency: string;
}): Buffer {
  for (const value of [
    input.shopId,
    input.merchantPricingUsageEventId,
    String(input.quotedAmountMinor),
    input.quotedCurrency,
  ]) assertCanonicalField(value);
  if (!Number.isSafeInteger(input.quotedAmountMinor) || input.quotedAmountMinor <= 0) {
    throw new TypeError("Shopify one-time charge quote must be a positive safe integer.");
  }
  return createHash("sha256").update(
    `arch027-topup-v1\nONE_TIME_CHARGE\n${input.shopId}\n${input.merchantPricingUsageEventId}\n${input.quotedAmountMinor}\n${input.quotedCurrency}\n`,
    "utf8",
  ).digest();
}

function safeCost(value: number): number | null {
  return Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function pricingCostMinor(event: ShopifyUsageEventQuote, quantity: number): number | null {
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  if (quantity === 0) return 0;

  if (event.pricingMode === MerchantPricingUsagePricingMode.FIXED) {
    if (!Number.isSafeInteger(event.fixedUnitAmountMinor) || (event.fixedUnitAmountMinor ?? -1) < 0) return null;
    return safeCost((event.fixedUnitAmountMinor ?? 0) * quantity);
  }

  const tiers = [...event.tiers].sort((left, right) => left.position - right.position);
  if (!tiers.length) return null;

  if (event.pricingMode === MerchantPricingUsagePricingMode.VOLUME) {
    const tier = tiers.find((candidate) => candidate.upTo === null || quantity <= candidate.upTo);
    if (!tier) return null;
    return safeCost(tier.flatAmountMinor + tier.amountPerUnitMinor * quantity);
  }

  let cost = 0;
  let previousUpper = 0;
  let remaining = quantity;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const capacity = tier.upTo === null ? remaining : tier.upTo - previousUpper;
    if (!Number.isFinite(capacity) || capacity <= 0) return null;
    const units = Math.min(remaining, capacity);
    cost += tier.flatAmountMinor + tier.amountPerUnitMinor * units;
    if (!Number.isSafeInteger(cost)) return null;
    remaining -= units;
    if (tier.upTo !== null) previousUpper = tier.upTo;
  }
  return remaining === 0 ? safeCost(cost) : null;
}

export function calculateShopifyUsageEventQuoteMinor(
  event: ShopifyUsageEventQuote,
  providerQuantityBefore: number,
): number | null {
  if (event.pricingMode === MerchantPricingUsagePricingMode.FIXED) {
    return Number.isSafeInteger(event.fixedUnitAmountMinor) && (event.fixedUnitAmountMinor ?? 0) > 0
      ? event.fixedUnitAmountMinor
      : null;
  }
  const before = pricingCostMinor(event, providerQuantityBefore);
  const after = pricingCostMinor(event, providerQuantityBefore + 1);
  if (before === null || after === null) return null;
  const quote = after - before;
  return Number.isSafeInteger(quote) && quote > 0 ? quote : null;
}

function sameFingerprint(stored: Uint8Array, expected: Buffer): boolean {
  const left = Buffer.from(stored);
  return left.length === expected.length && timingSafeEqual(left, expected);
}

export class ShopifyBillingOperationService {
  constructor(private readonly database: PrismaClient) {}

  async recordInitialPaidIntent(
    transaction: BillingOperationTransaction,
    input: {
      shopId: string;
      subscriptionId: string;
      targetPlanHandle: string;
      lifecycleEventId: string | null;
    },
  ): Promise<BillingOperation> {
    await this.assertShopifyShop(transaction, input.shopId);
    const quote = await this.requirePaidPlanQuote(transaction, input.targetPlanHandle);
    const requestKey = operationRequestKey(BillingOperationKind.SUBSCRIPTION_CREATE, [
      input.subscriptionId,
      input.lifecycleEventId ?? "initial",
      quote.id,
    ]);
    const requestFingerprint = shopifyRecurringRequestFingerprint({
      kind: BillingOperationKind.SUBSCRIPTION_CREATE,
      shopId: input.shopId,
      merchantPricingPlanId: quote.id,
      quotedAmountMinor: quote.recurringAmountMinor,
      quotedCurrency: quote.currency,
      quotedBillingPeriod: quote.billingPeriod,
    });
    return this.ensureOperation(transaction, {
      shopId: input.shopId,
      kind: BillingOperationKind.SUBSCRIPTION_CREATE,
      state: BillingOperationState.INITIATING,
      requestKey,
      requestFingerprint,
      merchantPricingPlanId: quote.id,
      merchantPricingUsageEventId: null,
      quotedAmountMinor: quote.recurringAmountMinor,
      quotedCurrency: quote.currency,
      quotedBillingPeriod: quote.billingPeriod,
      recoveryCreditPurchaseId: null,
      providerReference: null,
    });
  }

  async recordHostedPlanChange(
    transaction: BillingOperationTransaction,
    input: {
      shopId: string;
      requestedPlanHandle: string;
      previousPlanHandle: string | null;
      providerReference: string | null;
      result: "current" | "pending" | "no_active" | "mismatch" | "unverified";
      cancelAtEndOfCycle: boolean;
      providerCurrentPeriodStart: string | null;
      providerCurrentPeriodEnd: string | null;
      providerPendingEffectiveAt: string | null;
      previousCurrentPeriodEnd: Date | null;
      subscriptionId: string;
    },
  ): Promise<BillingOperation | null> {
    await this.assertShopifyShop(transaction, input.shopId);
    if (input.result === "unverified") return null;

    const target = await transaction.merchantPricingPlan.findUnique({
      where: { shopifyPlanHandle: input.requestedPlanHandle },
      select: {
        id: true,
        planKind: true,
        isActive: true,
        recurringAmountMinor: true,
        currency: true,
        billingPeriod: true,
      },
    });
    if (!target?.isActive) return null;

    const providerReference = nonBlank(input.providerReference);
    const boundary = input.providerPendingEffectiveAt ??
      input.providerCurrentPeriodStart ??
      input.providerCurrentPeriodEnd ??
      input.previousCurrentPeriodEnd?.toISOString() ??
      "unknown";

    if (target.planKind === MerchantPricingPlanKind.FREE) {
      if (
        !providerReference ||
        !input.previousPlanHandle ||
        input.previousPlanHandle === input.requestedPlanHandle ||
        (input.result !== "no_active" && !input.cancelAtEndOfCycle)
      ) return null;
      const kind = BillingOperationKind.CANCEL;
      const requestKey = operationRequestKey(kind, [providerReference, input.previousPlanHandle, boundary]);
      const requestFingerprint = shopifyRecurringRequestFingerprint({
        kind,
        shopId: input.shopId,
        providerReference,
      });
      const operation = await this.ensureOperation(transaction, {
        shopId: input.shopId,
        kind,
        state: BillingOperationState.CONFIRMED,
        requestKey,
        requestFingerprint,
        merchantPricingPlanId: null,
        merchantPricingUsageEventId: null,
        quotedAmountMinor: null,
        quotedCurrency: null,
        quotedBillingPeriod: null,
        recoveryCreditPurchaseId: null,
        providerReference,
      });
      return operation.state === BillingOperationState.CONFIRMED
        ? operation
        : this.confirmOperation(transaction, operation, providerReference);
    }

    if (input.result === "mismatch") return null;

    if (
      target.planKind !== MerchantPricingPlanKind.PAID_METERED ||
      !Number.isSafeInteger(target.recurringAmountMinor) ||
      target.recurringAmountMinor <= 0 ||
      !/^[A-Z]{3}$/.test(target.currency) ||
      target.billingPeriod !== MerchantPricingBillingPeriod.EVERY_30_DAYS ||
      input.result === "no_active" ||
      input.previousPlanHandle === input.requestedPlanHandle
    ) return null;

    if (!providerReference || !input.previousPlanHandle) return null;

    const kind = BillingOperationKind.PLAN_SWITCH;
    const requestKey = operationRequestKey(kind, [
      input.subscriptionId,
      input.previousPlanHandle,
      target.id,
      boundary,
      providerReference,
    ]);
    const requestFingerprint = shopifyRecurringRequestFingerprint({
      kind,
      shopId: input.shopId,
      providerReference,
      merchantPricingPlanId: target.id,
      quotedAmountMinor: target.recurringAmountMinor,
      quotedCurrency: target.currency,
      quotedBillingPeriod: target.billingPeriod,
    });
    const desiredState = input.result === "current"
      ? BillingOperationState.CONFIRMED
      : BillingOperationState.AWAITING_CONFIRMATION;
    const operation = await this.ensureOperation(transaction, {
      shopId: input.shopId,
      kind,
      state: desiredState,
      requestKey,
      requestFingerprint,
      merchantPricingPlanId: target.id,
      merchantPricingUsageEventId: null,
      quotedAmountMinor: target.recurringAmountMinor,
      quotedCurrency: target.currency,
      quotedBillingPeriod: target.billingPeriod,
      recoveryCreditPurchaseId: null,
      providerReference,
    });
    return desiredState === BillingOperationState.CONFIRMED
      ? this.confirmOperation(transaction, operation, providerReference)
      : operation;
  }

  async recordOneTimeChargeIntent(
    transaction: BillingOperationTransaction,
    input: {
      shopId: string;
      purchaseId: string;
      usageEvent: ShopifyUsageEventQuote;
      providerQuantityBefore: number;
      providerReference: string;
    },
  ): Promise<BillingOperation> {
    await this.assertShopifyShop(transaction, input.shopId);
    const quotedAmountMinor = calculateShopifyUsageEventQuoteMinor(
      input.usageEvent,
      input.providerQuantityBefore,
    );
    const providerReference = nonBlank(input.providerReference);
    if (
      quotedAmountMinor === null ||
      !/^[A-Z]{3}$/.test(input.usageEvent.currency) ||
      !providerReference
    ) {
      throw new Error("Shopify one-time charge operation quote is unavailable.");
    }
    const requestKey = `shopify:one-time-charge:${input.purchaseId}`;
    const requestFingerprint = shopifyOneTimeChargeRequestFingerprint({
      shopId: input.shopId,
      merchantPricingUsageEventId: input.usageEvent.id,
      quotedAmountMinor,
      quotedCurrency: input.usageEvent.currency,
    });
    return this.ensureOperation(transaction, {
      shopId: input.shopId,
      kind: BillingOperationKind.ONE_TIME_CHARGE,
      state: BillingOperationState.AWAITING_CONFIRMATION,
      requestKey,
      requestFingerprint,
      merchantPricingPlanId: null,
      merchantPricingUsageEventId: input.usageEvent.id,
      quotedAmountMinor,
      quotedCurrency: input.usageEvent.currency,
      quotedBillingPeriod: null,
      recoveryCreditPurchaseId: input.purchaseId,
      providerReference,
    });
  }

  async reconcileActiveSubscription(
    transaction: BillingOperationTransaction,
    input: {
      shopId: string;
      providerPlanHandle: string;
      providerReference: string | null;
      cancelAtEndOfCycle: boolean;
    },
  ): Promise<void> {
    const providerReference = nonBlank(input.providerReference);
    const currentPlan = await transaction.merchantPricingPlan.findUnique({
      where: { shopifyPlanHandle: input.providerPlanHandle },
      select: { id: true },
    });
    const operations = await transaction.billingOperation.findMany({
      where: {
        shopId: input.shopId,
        state: { in: [...OPEN_OPERATION_STATES] },
        kind: {
          in: [
            BillingOperationKind.SUBSCRIPTION_CREATE,
            BillingOperationKind.PLAN_SWITCH,
            BillingOperationKind.CANCEL,
          ],
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    if (currentPlan) {
      if (providerReference) {
        const exactCreates = operations.filter((operation) =>
          operation.kind === BillingOperationKind.SUBSCRIPTION_CREATE &&
          operation.merchantPricingPlanId === currentPlan.id &&
          operation.providerReference === providerReference,
        );
        if (exactCreates.length === 1) {
          await this.confirmOperation(transaction, exactCreates[0], providerReference);
        } else if (exactCreates.length === 0) {
          const unresolvedCreates = operations.filter((operation) =>
            operation.kind === BillingOperationKind.SUBSCRIPTION_CREATE &&
            operation.merchantPricingPlanId === currentPlan.id &&
            operation.providerReference === null,
          );
          if (unresolvedCreates.length === 1) {
            await this.confirmOperation(transaction, unresolvedCreates[0], providerReference);
          }
        }
      }

      const switches = operations.filter((operation) =>
        operation.kind === BillingOperationKind.PLAN_SWITCH &&
        operation.merchantPricingPlanId === currentPlan.id,
      );
      if (switches.length === 1) {
        await this.confirmOperation(transaction, switches[0], null);
      }
    }

    if (input.cancelAtEndOfCycle) {
      const cancellations = operations.filter((operation) =>
        operation.kind === BillingOperationKind.CANCEL,
      );
      if (cancellations.length === 1) {
        await this.confirmOperation(transaction, cancellations[0], null);
      }
    }
  }

  async reconcileNoActiveSubscription(
    transaction: BillingOperationTransaction,
    input: { shopId: string },
  ): Promise<void> {
    const operations = await transaction.billingOperation.findMany({
      where: {
        shopId: input.shopId,
        kind: BillingOperationKind.CANCEL,
        state: { in: [...OPEN_OPERATION_STATES] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (operations.length === 1) {
      await this.confirmOperation(transaction, operations[0], null);
    }
  }

  private async assertShopifyShop(
    transaction: BillingOperationTransaction,
    shopId: string,
  ): Promise<void> {
    const shop = await transaction.shop.findUnique({
      where: { id: shopId },
      select: { platform: true },
    });
    if (shop?.platform !== ShopPlatform.SHOPIFY) {
      throw new Error("Shopify billing operations require a Shopify Shop.");
    }
  }

  private async requirePaidPlanQuote(
    transaction: BillingOperationTransaction,
    planHandle: string,
  ): Promise<PaidPlanQuote> {
    const plan = await transaction.merchantPricingPlan.findUnique({
      where: { shopifyPlanHandle: planHandle },
      select: {
        id: true,
        planKind: true,
        isActive: true,
        recurringAmountMinor: true,
        currency: true,
        billingPeriod: true,
      },
    });
    if (
      !plan ||
      !plan.isActive ||
      plan.planKind !== MerchantPricingPlanKind.PAID_METERED ||
      !Number.isSafeInteger(plan.recurringAmountMinor) ||
      plan.recurringAmountMinor <= 0 ||
      !/^[A-Z]{3}$/.test(plan.currency) ||
      plan.billingPeriod !== MerchantPricingBillingPeriod.EVERY_30_DAYS
    ) {
      throw new Error("Shopify paid billing operation quote is unavailable.");
    }
    return plan;
  }

  private async ensureOperation(
    transaction: BillingOperationTransaction,
    input: {
      shopId: string;
      kind: BillingOperationKind;
      state: BillingOperationState;
      requestKey: string;
      requestFingerprint: Buffer;
      merchantPricingPlanId: string | null;
      merchantPricingUsageEventId: string | null;
      quotedAmountMinor: number | null;
      quotedCurrency: string | null;
      quotedBillingPeriod: MerchantPricingBillingPeriod | null;
      recoveryCreditPurchaseId: string | null;
      providerReference: string | null;
    },
  ): Promise<BillingOperation> {
    const operation = await transaction.billingOperation.upsert({
      where: {
        shopId_requestKey: {
          shopId: input.shopId,
          requestKey: input.requestKey,
        },
      },
      update: {},
      create: {
        shopId: input.shopId,
        kind: input.kind,
        state: input.state,
        requestKey: input.requestKey,
        requestFingerprint: new Uint8Array(input.requestFingerprint),
        merchantPricingPlanId: input.merchantPricingPlanId,
        merchantPricingUsageEventId: input.merchantPricingUsageEventId,
        quotedAmountMinor: input.quotedAmountMinor,
        quotedCurrency: input.quotedCurrency,
        quotedBillingPeriod: input.quotedBillingPeriod,
        recoveryCreditPurchaseId: input.recoveryCreditPurchaseId,
        providerReference: input.providerReference,
        confirmationUrl: null,
        lastErrorCode: null,
      },
    });
    if (
      operation.shopId !== input.shopId ||
      operation.kind !== input.kind ||
      operation.merchantPricingPlanId !== input.merchantPricingPlanId ||
      operation.merchantPricingUsageEventId !== input.merchantPricingUsageEventId ||
      operation.quotedAmountMinor !== input.quotedAmountMinor ||
      operation.quotedCurrency !== input.quotedCurrency ||
      operation.quotedBillingPeriod !== input.quotedBillingPeriod ||
      operation.recoveryCreditPurchaseId !== input.recoveryCreditPurchaseId ||
      !sameFingerprint(operation.requestFingerprint, input.requestFingerprint)
    ) {
      throw new Error("Shopify billing operation idempotency conflict.");
    }
    if (
      input.providerReference &&
      operation.providerReference &&
      operation.providerReference !== input.providerReference
    ) {
      throw new Error("Shopify billing operation provider reference conflict.");
    }
    if (
      input.state === BillingOperationState.CONFIRMED &&
      input.providerReference
    ) {
      return this.confirmOperation(transaction, operation, input.providerReference);
    }
    if (
      input.state === BillingOperationState.AWAITING_CONFIRMATION &&
      operation.state === BillingOperationState.INITIATING &&
      input.providerReference
    ) {
      await transaction.billingOperation.updateMany({
        where: {
          id: operation.id,
          state: BillingOperationState.INITIATING,
          providerReference: input.providerReference,
        },
        data: { state: BillingOperationState.AWAITING_CONFIRMATION, lastErrorCode: null },
      });
      return this.requireOperation(transaction, operation.id);
    }
    return operation;
  }

  private async confirmOperation(
    transaction: BillingOperationTransaction,
    operation: BillingOperation,
    trustedProviderReference: string | null,
  ): Promise<BillingOperation> {
    const providerReference = operation.providerReference ?? nonBlank(trustedProviderReference);
    if (!providerReference) return operation;
    if (
      operation.providerReference &&
      trustedProviderReference &&
      operation.kind === BillingOperationKind.SUBSCRIPTION_CREATE &&
      operation.providerReference !== trustedProviderReference
    ) {
      throw new Error("Shopify billing operation provider reference conflict.");
    }

    await transaction.billingOperation.updateMany({
      where: {
        id: operation.id,
        state: { in: [...OPEN_OPERATION_STATES] },
        ...(operation.providerReference
          ? { providerReference: operation.providerReference }
          : { providerReference: null }),
      },
      data: {
        state: BillingOperationState.CONFIRMED,
        providerReference,
        lastErrorCode: null,
      },
    });
    const confirmed = await this.requireOperation(transaction, operation.id);
    if (confirmed.providerReference !== providerReference) {
      throw new Error("Shopify billing operation provider reference conflict.");
    }
    return confirmed;
  }

  private async requireOperation(
    transaction: BillingOperationTransaction,
    id: string,
  ): Promise<BillingOperation> {
    const operation = await transaction.billingOperation.findUnique({ where: { id } });
    if (!operation) throw new Error("Shopify billing operation disappeared during reconciliation.");
    return operation;
  }
}
