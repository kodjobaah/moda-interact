import { parseEffectiveRecoveryPolicy, type RecoveryOfferMode } from "@modainteract/moda-interact-shared/recovery-policy";
import type { Prisma } from "@prisma/client";
import db from "@/db.server";

const MAX_DELAY_MINUTES = 10080;

type RecoveryPolicyValue = {
  recoveryDelayMinutes: number;
  recoveryOfferMode: RecoveryOfferMode;
  fixedShopifyDiscountId?: string | null;
  followUpEnabled: boolean;
  followUpDelayMinutes?: number | null;
};

type DiscountValue = {
  fixedSelectable: boolean;
  isAvailable: boolean;
  providerStatus: string;
  startsAt: Date | null;
  endsAt: Date | null;
};

export class RecoveryPolicyValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function activeDiscount(discount: DiscountValue | undefined, now: Date) {
  return discount
    && discount.fixedSelectable
    && discount.isAvailable
    && discount.providerStatus === "ACTIVE"
    && (!discount.startsAt || discount.startsAt <= now)
    && (!discount.endsAt || discount.endsAt > now);
}

function toPolicy(value: RecoveryPolicyValue, source: "MERCHANT" | "ADMIN_OVERRIDE") {
  return parseEffectiveRecoveryPolicy({
    recoveryDelayMinutes: value.recoveryDelayMinutes,
    recoveryOfferMode: value.recoveryOfferMode,
    fixedShopifyDiscountId: value.fixedShopifyDiscountId ?? null,
    followUpEnabled: value.followUpEnabled,
    followUpDelayMinutes: value.followUpDelayMinutes ?? null,
    source,
  });
}

export async function loadRecoveryPolicySnapshot(shopId: string, now = new Date(), client = db) {
  const [settings, override, catalogue] = await Promise.all([
    client.shopSettings.findUnique({ where: { shopId } }),
    client.shopRecoveryPolicyOverride.findFirst({ where: { shopId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    client.shopifyDiscountCatalogue.findUnique({ where: { shopId }, include: { discounts: { orderBy: { title: "asc" } } } }),
  ]);
  if (!settings) throw new RecoveryPolicyValidationError("SETTINGS_NOT_FOUND");
  const merchant = toPolicy(settings, "MERCHANT");
  const effective = override ? toPolicy(override, "ADMIN_OVERRIDE") : merchant;
  const discounts = catalogue?.status === "CURRENT"
    ? catalogue.discounts.filter((discount) => isCurrentlyRunning(discount, now))
    : [];
  return {
    merchant,
    effective,
    overrideActive: Boolean(override),
    catalogueStatus: catalogue?.status ?? "UNAVAILABLE",
    discounts: discounts.map((discount) => ({
      id: discount.id, title: discount.title, summary: discount.summary,
      method: discount.method, providerStatus: discount.providerStatus,
      startsAt: discount.startsAt, endsAt: discount.endsAt,
      singleRedeemCode: discount.singleRedeemCode, fixedSelectable: discount.fixedSelectable,
    })),
  };
}

export function isCurrentlyRunning(discount: DiscountValue, now: Date) {
  return discount.isAvailable && discount.providerStatus === "ACTIVE" &&
    (!discount.startsAt || discount.startsAt <= now) &&
    (!discount.endsAt || discount.endsAt > now);
}

export function parseMerchantRecoveryPolicy(input: {
  recoveryDelayMinutes: unknown;
  recoveryOfferMode: unknown;
  fixedShopifyDiscountId?: unknown;
  followUpEnabled: unknown;
  followUpDelayMinutes?: unknown;
}) {
  if (typeof input.recoveryDelayMinutes !== "string" || !input.recoveryDelayMinutes.trim()) throw new RecoveryPolicyValidationError("INVALID_RECOVERY_DELAY");
  const recoveryDelayMinutes = Number(input.recoveryDelayMinutes);
  const recoveryOfferMode = String(input.recoveryOfferMode) as RecoveryOfferMode;
  const followUpEnabled = input.followUpEnabled === true || input.followUpEnabled === "true" || input.followUpEnabled === "on";
  const followUpDelayMinutes = !followUpEnabled ? null : input.followUpDelayMinutes === "" || input.followUpDelayMinutes == null
    ? null
    : Number(input.followUpDelayMinutes);
  const fixedShopifyDiscountId = input.fixedShopifyDiscountId ? String(input.fixedShopifyDiscountId) : null;
  return parseEffectiveRecoveryPolicy({ recoveryDelayMinutes, recoveryOfferMode, fixedShopifyDiscountId, followUpEnabled, followUpDelayMinutes, source: "MERCHANT" });
}

export async function saveMerchantRecoveryPolicy(shopId: string, input: Parameters<typeof parseMerchantRecoveryPolicy>[0], now = new Date()) {
  const policy = parseMerchantRecoveryPolicy(input);
  if (policy.recoveryDelayMinutes < 0 || policy.recoveryDelayMinutes > MAX_DELAY_MINUTES) throw new RecoveryPolicyValidationError("INVALID_RECOVERY_DELAY");
  if (policy.followUpEnabled && (policy.followUpDelayMinutes == null || policy.followUpDelayMinutes < 1 || policy.followUpDelayMinutes > MAX_DELAY_MINUTES)) throw new RecoveryPolicyValidationError("INVALID_FOLLOW_UP_DELAY");
  return db.$transaction(async (transaction: Prisma.TransactionClient) => {
    if (policy.recoveryOfferMode === "FIXED") {
      const catalogue = await transaction.shopifyDiscountCatalogue.findUnique({ where: { shopId }, include: { discounts: true } });
      const discount = catalogue?.discounts.find((candidate: DiscountValue & { id: string }) => candidate.id === policy.fixedShopifyDiscountId);
      if (catalogue?.status !== "CURRENT" || !activeDiscount(discount, now)) throw new RecoveryPolicyValidationError("FIXED_DISCOUNT_UNAVAILABLE");
    }
    return transaction.shopSettings.update({
      where: { shopId },
      data: {
        recoveryDelayMinutes: policy.recoveryDelayMinutes,
        recoveryOfferMode: policy.recoveryOfferMode,
        fixedShopifyDiscountId: policy.fixedShopifyDiscountId,
        followUpEnabled: policy.followUpEnabled,
        followUpDelayMinutes: policy.followUpDelayMinutes,
      },
    });
  });
}

export { activeDiscount };