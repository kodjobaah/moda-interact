import {describe, expect, it} from "vitest";
import {BillingOperationKind, ShopPlatform, type BillingOperation} from "@prisma/client";
import {ShopifyBillingOperationService, shopifyRecurringRequestFingerprint, shopifyOneTimeChargeRequestFingerprint} from "../../app/services/billing/shopify-billing-operation.service";

// Derived independently with Python hashlib.sha256 over UTF-8 newline-terminated fields.
const vectors = {
  "createKey": "25d66ce262026a707985da0611ec9d7bbcd0b0538071325f0403d7da3f3bb84d",
  "switchKey": "3392a6dcd3f37aec9df7949b781a994b2f76c68ebfe8ab9b9fd932fdac676e63",
  "cancelKey": "523482f90f100498ca92f722de9ce65179b0752cb5acda8c3b95f1ad206a2788",
  "createFingerprint": "3e42a42f6c3c7af1b1ca68b166a3a236cb743c3829de99a50f5486b1b131b21c",
  "switchFingerprint": "0d3c7fcf3094462c85f4c38f88c259be6f044f768c948cceda4f7546b5ad40fa",
  "cancelFingerprint": "6bed48ddeb1183b800ab6c6a7bd126726789552587b679fc831690c1b7a2e859",
  "chargeFingerprint": "67a15774769aa0d1ae1f588195b234213a949f73c63fd61a2fa9fe178d7c5758"
};
const quote = {kind: BillingOperationKind.SUBSCRIPTION_CREATE, shopId: "shop-雪", merchantPricingPlanId: "plan-東京", quotedAmountMinor: 4900, quotedCurrency: "USD", quotedBillingPeriod: "EVERY_30_DAYS" as const};
const topup = {shopId: "shop-雪", merchantPricingUsageEventId: "usage-é", quotedAmountMinor: 500, quotedCurrency: "USD"};
const boundary = "2026-11-30T00:00:00.000Z";
function harness() {
  const operations: BillingOperation[] = [];
  const paid = {id: "plan-東京", planKind: "PAID_METERED", isActive: true, recurringAmountMinor: 4900, currency: "USD", billingPeriod: "EVERY_30_DAYS"};
  const tx = {
    shop: {findUnique: async () => ({platform: ShopPlatform.SHOPIFY})},
    merchantPricingPlan: {findUnique: async ({where}: {where: {shopifyPlanHandle: string}}) => where.shopifyPlanHandle === "free" ? {...paid, id: "plan-free", planKind: "FREE", recurringAmountMinor: 0} : paid},
    billingOperation: {
      upsert: async ({create}: {create: BillingOperation}) => {
        const existing = operations.find(row => row.shopId === create.shopId && row.requestKey === create.requestKey);
        if (existing) return existing;
        const row = {...create, id: `operation-${operations.length + 1}`}; operations.push(row); return row;
      },
      updateMany: async ({where, data}: {where: {id: string}; data: Partial<BillingOperation>}) => {
        Object.assign(operations.find(row => row.id === where.id)!, data); return {count: 1};
      },
      findUnique: async ({where}: {where: {id: string}}) => operations.find(row => row.id === where.id),
    },
  };
  const service = new ShopifyBillingOperationService({} as never);
  const initial = (subscriptionId = "subscription-été", shopId = "shop-雪") => service.recordInitialPaidIntent(tx as never, {shopId, subscriptionId, targetPlanHandle: "growth"});
  const change = (cancel: boolean, providerReference: string | null = null, time = boundary) => service.recordHostedPlanChange(tx as never, {
    shopId: "shop-雪", requestedPlanHandle: cancel ? "free" : "scale", previousPlanHandle: "growth", providerReference,
    result: cancel ? "no_active" : "pending", cancelAtEndOfCycle: cancel, providerCurrentPeriodStart: null,
    providerCurrentPeriodEnd: time, providerPendingEffectiveAt: null, previousCurrentPeriodEnd: null, subscriptionId: "subscription-été",
  });
  const charge = () => service.recordOneTimeChargeIntent(tx as never, {shopId: "shop-雪", purchaseId: "purchase-é", providerQuantityBefore: 0,
    usageEvent: {id: "usage-é", pricingMode: "FIXED", currency: "USD", fixedUnitAmountMinor: 500, tiers: []}});
  return {initial, change, charge, tx, paid, operations};
}

describe("canonical development billing identities", () => {
  it("matches fixed recurring and one-time fingerprint vectors with non-ASCII UTF-8 fields", () => {
    expect(shopifyRecurringRequestFingerprint(quote).toString("hex")).toBe(vectors.createFingerprint);
    expect(shopifyRecurringRequestFingerprint({...quote, kind: BillingOperationKind.PLAN_SWITCH}).toString("hex")).toBe(vectors.switchFingerprint);
    expect(shopifyRecurringRequestFingerprint({kind: BillingOperationKind.CANCEL, shopId: quote.shopId}).toString("hex")).toBe(vectors.cancelFingerprint);
    expect(shopifyOneTimeChargeRequestFingerprint(topup).toString("hex")).toBe(vectors.chargeFingerprint);
  });
  it("observes all four real kinds through public service methods and replays fresh canonical intents", async () => {
    const h = harness();
    const create = await h.initial(); expect((await h.initial()).id).toBe(create.id);
    expect(create.requestKey).toBe(`shopify:subscription_create:${vectors.createKey}`);
    expect(Buffer.from(create.requestFingerprint).toString("hex")).toBe(vectors.createFingerprint);
    const change = await h.change(false); expect((await h.change(false))?.id).toBe(change?.id);
    expect(change?.requestKey).toBe(`shopify:plan_switch:${vectors.switchKey}`);
    expect(Buffer.from(change!.requestFingerprint).toString("hex")).toBe(vectors.switchFingerprint);
    const cancel = await h.change(true); expect((await h.change(true))?.id).toBe(cancel?.id);
    expect(cancel?.requestKey).toBe(`shopify:cancel:${vectors.cancelKey}`);
    expect(Buffer.from(cancel!.requestFingerprint).toString("hex")).toBe(vectors.cancelFingerprint);
    const charge = await h.charge(); expect((await h.charge()).id).toBe(charge.id);
    expect(charge.requestKey).toBe("shopify:one-time-charge:purchase-é");
    expect(Buffer.from(charge.requestFingerprint).toString("hex")).toBe(vectors.chargeFingerprint);
    expect(h.operations).toHaveLength(4);
  });
  it.each(["shopId", "merchantPricingPlanId", "quotedAmountMinor", "quotedCurrency"] as const)("includes recurring %s in identity", field => {
    const altered = {...quote, [field]: field === "quotedAmountMinor" ? 4901 : `${quote[field]}x`};
    expect(shopifyRecurringRequestFingerprint(altered)).not.toEqual(shopifyRecurringRequestFingerprint(quote));
  });
  it.each(["shopId", "merchantPricingUsageEventId", "quotedAmountMinor", "quotedCurrency"] as const)("includes top-up %s in identity", field => {
    expect(shopifyOneTimeChargeRequestFingerprint({...topup, [field]: field === "quotedAmountMinor" ? 501 : `${topup[field]}x`})).not.toEqual(shopifyOneTimeChargeRequestFingerprint(topup));
  });
  it("ignores irrelevant quote fields for cancellation and excludes provider references from keys/fingerprints", async () => {
    expect(shopifyRecurringRequestFingerprint({...quote, kind: BillingOperationKind.CANCEL})).toEqual(shopifyRecurringRequestFingerprint({kind: BillingOperationKind.CANCEL, shopId: quote.shopId}));
    const h = harness(); const first = await h.change(false);
    const attached = await h.change(false, "provider-é");
    expect(attached?.id).toBe(first?.id); expect(attached?.requestKey).toBe(first?.requestKey);
    expect(attached?.requestFingerprint).toEqual(first?.requestFingerprint);
    await expect(h.change(false, "different-provider")).rejects.toThrow("provider reference conflict");
    expect((await h.change(false, "provider-é", "2026-12-30T00:00:00.000Z"))?.requestKey).not.toBe(first?.requestKey);
  });
  it("retains bounded quote conflicts and distinct subscription/tenant identities", async () => {
    const h = harness(); const first = await h.initial();
    expect((await h.initial("different-subscription")).requestKey).not.toBe(first.requestKey);
    expect((await h.initial("subscription-été", "different-shop")).requestFingerprint).not.toEqual(first.requestFingerprint);
    h.paid.recurringAmountMinor = 4901;
    await expect(h.initial()).rejects.toThrow("idempotency conflict");
    expect(h.operations).toHaveLength(3);
  });
  it.each(["\n", "\r", "\u0000", "\u001f", "\u007f"])("rejects control character %j without writing an operation", async control => {
    expect(() => shopifyRecurringRequestFingerprint({...quote, shopId: `shop${control}`})).toThrow(TypeError);
    expect(() => shopifyOneTimeChargeRequestFingerprint({...topup, merchantPricingUsageEventId: `usage${control}`})).toThrow(TypeError);
    const h = harness(); await expect(h.initial(`subscription${control}`)).rejects.toThrow(TypeError);
    expect(h.operations).toHaveLength(0);
  });
});
