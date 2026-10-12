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
        !input.previousPlanHandle ||
        input.previousPlanHandle === input.requestedPlanHandle ||
        (input.result !== "no_active" && !input.cancelAtEndOfCycle)
      ) return null;
      const kind = BillingOperationKind.CANCEL;
      const requestKey = operationRequestKey(kind, [input.subscriptionId, input.previousPlanHandle, boundary]);
      const requestFingerprint = shopifyRecurringRequestFingerprint({
        kind,
        shopId: input.shopId,
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

    if (!input.previousPlanHandle) return null;

    const kind = BillingOperationKind.PLAN_SWITCH;
    const requestKey = operationRequestKey(kind, [
      input.subscriptionId,
      input.previousPlanHandle,
      target.id,
      boundary,
    ]);
    const requestFingerprint = shopifyRecurringRequestFingerprint({
      kind,
      shopId: input.shopId,
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
    },
  ): Promise<BillingOperation> {
    await this.assertShopifyShop(transaction, input.shopId);
    const quotedAmountMinor = calculateShopifyUsageEventQuoteMinor(
      input.usageEvent,
      input.providerQuantityBefore,
    );
    if (
      quotedAmountMinor === null ||
      !/^[A-Z]{3}$/.test(input.usageEvent.currency)
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
      state: BillingOperationState.INITIATING,
      requestKey,
      requestFingerprint,
      merchantPricingPlanId: null,
      merchantPricingUsageEventId: input.usageEvent.id,
      quotedAmountMinor,
      quotedCurrency: input.usageEvent.currency,
      quotedBillingPeriod: null,
      recoveryCreditPurchaseId: input.purchaseId,
      providerReference: null,
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
      const createsForPlan = operations.filter((operation) =>
        operation.kind === BillingOperationKind.SUBSCRIPTION_CREATE &&
        operation.merchantPricingPlanId === currentPlan.id,
      );
      const exactCreates = providerReference
        ? createsForPlan.filter((operation) => operation.providerReference === providerReference)
        : createsForPlan;
      const unresolvedCreates = createsForPlan.filter((operation) => operation.providerReference === null);
      const matchingCreate = exactCreates.length === 1
        ? exactCreates[0]
        : exactCreates.length === 0 && unresolvedCreates.length === 1
          ? unresolvedCreates[0]
          : null;
      if (matchingCreate) {
        await this.confirmOperation(transaction, matchingCreate, providerReference);
      }

      const switches = operations.filter((operation) =>
        operation.kind === BillingOperationKind.PLAN_SWITCH &&
        operation.merchantPricingPlanId === currentPlan.id,
      );
      const exactSwitches = providerReference
        ? switches.filter((operation) => operation.providerReference === providerReference)
        : switches;
      const unresolvedSwitches = switches.filter((operation) => operation.providerReference === null);
      const matchingSwitch = exactSwitches.length === 1
        ? exactSwitches[0]
        : exactSwitches.length === 0 && unresolvedSwitches.length === 1
          ? unresolvedSwitches[0]
          : null;
      if (matchingSwitch) {
        await this.confirmOperation(transaction, matchingSwitch, providerReference);
      }
    }

    if (input.cancelAtEndOfCycle) {
      const cancellations = operations.filter((operation) =>
        operation.kind === BillingOperationKind.CANCEL,
      );
      const exactCancellations = providerReference
        ? cancellations.filter((operation) => operation.providerReference === providerReference)
        : cancellations;
      const unresolvedCancellations = cancellations.filter((operation) => operation.providerReference === null);
      const matchingCancellation = exactCancellations.length === 1
        ? exactCancellations[0]
        : exactCancellations.length === 0 && unresolvedCancellations.length === 1
          ? unresolvedCancellations[0]
          : null;
      if (matchingCancellation) {
        await this.confirmOperation(transaction, matchingCancellation, providerReference);
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
    let operation = await transaction.billingOperation.upsert({
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
    if (input.state === BillingOperationState.CONFIRMED) {
      return this.confirmOperation(transaction, operation, input.providerReference);
    }
    if (input.providerReference && operation.providerReference === null) {
      operation = await this.attachProviderReference(transaction, operation, input.providerReference);
    }
    if (
      input.state === BillingOperationState.AWAITING_CONFIRMATION &&
      operation.state === BillingOperationState.INITIATING
    ) {
      await transaction.billingOperation.updateMany({
        where: {
          id: operation.id,
          state: BillingOperationState.INITIATING,
          providerReference: operation.providerReference,
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
    const providerReference = nonBlank(trustedProviderReference);
    if (
      operation.providerReference &&
      trustedProviderReference &&
      operation.providerReference !== trustedProviderReference
    ) {
      throw new Error("Shopify billing operation provider reference conflict.");
    }

    await transaction.billingOperation.updateMany({
      where: {
        id: operation.id,
        state: { in: [...OPEN_OPERATION_STATES, BillingOperationState.CONFIRMED] },
        ...(operation.providerReference
          ? { providerReference: operation.providerReference }
          : { providerReference: null }),
      },
      data: {
        state: BillingOperationState.CONFIRMED,
        providerReference: providerReference ?? operation.providerReference,
        lastErrorCode: null,
      },
    });
    const confirmed = await this.requireOperation(transaction, operation.id);
    if (providerReference && confirmed.providerReference !== providerReference) {
      throw new Error("Shopify billing operation provider reference conflict.");
    }
    return confirmed;
  }

  private async attachProviderReference(
    transaction: BillingOperationTransaction,
    operation: BillingOperation,
    providerReference: string,
  ): Promise<BillingOperation> {
    await transaction.billingOperation.updateMany({
      where: { id: operation.id, providerReference: null },
      data: { providerReference },
    });
    const updated = await this.requireOperation(transaction, operation.id);
    if (updated.providerReference !== providerReference) {
      throw new Error("Shopify billing operation provider reference conflict.");
    }
    return updated;
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
