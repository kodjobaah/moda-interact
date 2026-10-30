import { lockSettingsShop, revisionOf, PreferenceError } from "../feature-preferences/feature-preferences.server";
import { parseEffectiveRecoveryPolicy, type RecoveryOfferMode } from "@modainteract/moda-interact-shared/recovery-policy";
import type { Prisma, PrismaClient } from "@prisma/client";
import db from "@/db.server";

const MAX_DELAY_MINUTES = 10080;

type RecoveryPolicyValue = {
  recoveryDelayMinutes: number;
  recoveryOfferMode: RecoveryOfferMode;
  selectedDiscountIds?: string[];
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

function toPolicy(value: RecoveryPolicyValue, source: "MERCHANT" | "ADMIN_OVERRIDE") {
  return parseEffectiveRecoveryPolicy({
    recoveryDelayMinutes: value.recoveryDelayMinutes,
    recoveryOfferMode: value.recoveryOfferMode,
    fixedShopifyDiscountId: value.recoveryOfferMode === "FIXED"
      ? value.selectedDiscountIds?.[0] ?? value.fixedShopifyDiscountId ?? null
      : null,
    followUpEnabled: value.followUpEnabled,
    followUpDelayMinutes: value.followUpDelayMinutes ?? null,
    source,
  });
}

export async function loadRecoveryPolicySnapshot(shopId: string, now = new Date(), client: PrismaClient = db) {
  const [settings, override, catalogue] = await Promise.all([
    client.shopSettings.findUnique({ where: { shopId } }),
    client.shopRecoveryPolicyOverride.findFirst({ where: { shopId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    client.shopifyDiscountCatalogue.findUnique({ where: { shopId }, include: { discounts: { orderBy: { title: "asc" } } } }),
  ]);
  if (!settings) throw new RecoveryPolicyValidationError("SETTINGS_NOT_FOUND");
  const merchant = toPolicy(settings, "MERCHANT");
  const effective = override ? toPolicy(override, "ADMIN_OVERRIDE") : merchant;
  const discounts = catalogue?.discounts ?? [];
  return {
    merchant,
    notifyOnInitialRecoveryOutreach: settings.notifyOnInitialRecoveryOutreach ?? false,
    revision: settings.updatedAt.toISOString(),
    effective,
    overrideActive: Boolean(override),
    catalogueStatus: catalogue?.status ?? "UNAVAILABLE",
    catalogueGeneration: catalogue?.syncGeneration ?? 0,
    selectedDiscountIds: discounts
      .filter((discount) => discount.isAvailable)
      .map((discount) => discount.id)
      .sort(compareAscii),
    discounts: discounts.map((discount) => ({
      id: discount.id, title: discount.title, summary: discount.summary,
      method: discount.method, providerStatus: discount.providerStatus,
      startsAt: discount.startsAt, endsAt: discount.endsAt,
      singleRedeemCode: discount.singleRedeemCode, fixedSelectable: discount.fixedSelectable,
      isAvailable: discount.isAvailable, unavailableAt: discount.unavailableAt,
      lastSyncedAt: discount.lastSyncedAt,
      lastSeenSyncGeneration: discount.lastSeenSyncGeneration,
    })),
    merchantFixedDiscount: resolveFixedIdentity(settings.fixedShopifyDiscountId, catalogue?.discounts ?? []),
    effectiveFixedDiscount: resolveFixedIdentity(effective.fixedShopifyDiscountId, catalogue?.discounts ?? []),
  };
}

function resolveFixedIdentity(id: string | null, discounts: Array<{ id: string; title: string | null }>) {
  if (!id) return null;
  return { id, title: discounts.find((discount) => discount.id === id)?.title ?? null };
}

function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isCurrentlyRunning(discount: DiscountValue, now: Date) {
  return discount.providerStatus === "ACTIVE" &&
    (!discount.startsAt || discount.startsAt <= now) &&
    (!discount.endsAt || discount.endsAt > now);
}

export function parseMerchantRecoveryPolicy(input: {
  recoveryDelayMinutes: unknown;
  recoveryOfferMode: unknown;
  selectedDiscountIds: unknown;
  followUpEnabled: unknown;
  followUpDelayMinutes?: unknown;
  notifyOnInitialRecoveryOutreach: unknown;
}) {
  if (typeof input.recoveryDelayMinutes !== "string" || !input.recoveryDelayMinutes.trim()) throw new RecoveryPolicyValidationError("INVALID_RECOVERY_DELAY");
  const recoveryDelayMinutes = Number(input.recoveryDelayMinutes);
  const recoveryOfferMode = String(input.recoveryOfferMode) as RecoveryOfferMode;
  if (
    !Array.isArray(input.selectedDiscountIds) ||
    input.selectedDiscountIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(input.selectedDiscountIds).size !== input.selectedDiscountIds.length
  ) throw new RecoveryPolicyValidationError("INVALID_DISCOUNT_SELECTION");
  if (input.selectedDiscountIds.length > 50) throw new RecoveryPolicyValidationError("TOO_MANY_DISCOUNTS");
  const selectedDiscountIds = [...input.selectedDiscountIds].sort(compareAscii);
  if (recoveryOfferMode === "FIXED" && selectedDiscountIds.length === 0)
    throw new RecoveryPolicyValidationError("FIXED_SELECTION_REQUIRED");
  const followUpEnabled = input.followUpEnabled === true || input.followUpEnabled === "true" || input.followUpEnabled === "on";
  const followUpDelayMinutes = !followUpEnabled ? null : input.followUpDelayMinutes === "" || input.followUpDelayMinutes == null
    ? null
    : Number(input.followUpDelayMinutes);
  if (typeof input.notifyOnInitialRecoveryOutreach !== "boolean") throw new RecoveryPolicyValidationError("INVALID_INITIAL_OUTREACH_NOTIFICATION");
  const policy = parseEffectiveRecoveryPolicy({
    recoveryDelayMinutes,
    recoveryOfferMode,
    fixedShopifyDiscountId: recoveryOfferMode === "FIXED" ? selectedDiscountIds[0] : null,
    followUpEnabled,
    followUpDelayMinutes,
    source: "MERCHANT",
  });
  return { ...policy, selectedDiscountIds };
}

export async function saveMerchantRecoveryPolicy(shopId: string, input: Parameters<typeof parseMerchantRecoveryPolicy>[0], expectedRevision: string, client: PrismaClient = db) {
  const policy = parseMerchantRecoveryPolicy(input);
  const notifyOnInitialRecoveryOutreach = input.notifyOnInitialRecoveryOutreach;
  if (typeof notifyOnInitialRecoveryOutreach !== "boolean") throw new RecoveryPolicyValidationError("INVALID_INITIAL_OUTREACH_NOTIFICATION");
  if (policy.recoveryDelayMinutes < 0 || policy.recoveryDelayMinutes > MAX_DELAY_MINUTES) throw new RecoveryPolicyValidationError("INVALID_RECOVERY_DELAY");
  if (policy.followUpEnabled && (policy.followUpDelayMinutes == null || policy.followUpDelayMinutes < 1 || policy.followUpDelayMinutes > MAX_DELAY_MINUTES)) throw new RecoveryPolicyValidationError("INVALID_FOLLOW_UP_DELAY");
  return client.$transaction(async (transaction: Prisma.TransactionClient) => {
    await lockSettingsShop(transaction, shopId);
    const current = await transaction.shopSettings.findUniqueOrThrow({where: {shopId}});
    if (expectedRevision !== current.updatedAt.toISOString()) throw new PreferenceError("CONFLICT");
    const ownedDiscounts = policy.selectedDiscountIds.length
      ? await transaction.shopifyDiscount.findMany({
          where: { shopId, id: { in: policy.selectedDiscountIds } },
          select: { id: true },
        })
      : [];
    if (ownedDiscounts.length !== policy.selectedDiscountIds.length)
      throw new RecoveryPolicyValidationError("INVALID_DISCOUNT_SELECTION");
    const previouslySelected = await transaction.shopifyDiscount.findMany({
      where: { shopId, isAvailable: true },
      select: { id: true },
    });
    const previousIds = previouslySelected.map((discount: { id: string }) => discount.id).sort(compareAscii);
    const selectionsChanged = previousIds.length !== policy.selectedDiscountIds.length ||
      previousIds.some((id, index) => id !== policy.selectedDiscountIds[index]);

    await transaction.shopifyDiscount.updateMany({
      where: { shopId, isAvailable: true },
      data: { isAvailable: false },
    });
    const selectedUpdate = await transaction.shopifyDiscount.updateMany({
      where: { shopId, id: { in: policy.selectedDiscountIds } },
      data: { isAvailable: true },
    });
    if (selectedUpdate.count !== policy.selectedDiscountIds.length)
      throw new RecoveryPolicyValidationError("DISCOUNT_SELECTION_CHANGED");

    if (
      !selectionsChanged &&
      revisionOf(toPolicy(current, "MERCHANT")) === revisionOf(toPolicy(policy, "MERCHANT")) &&
      current.notifyOnInitialRecoveryOutreach === notifyOnInitialRecoveryOutreach
    ) return current;
    return transaction.shopSettings.update({
      where: { shopId },
      data: {
        recoveryDelayMinutes: policy.recoveryDelayMinutes,
        recoveryOfferMode: policy.recoveryOfferMode,
        fixedShopifyDiscountId: policy.recoveryOfferMode === "FIXED"
          ? policy.selectedDiscountIds[0] ?? null
          : null,
        followUpEnabled: policy.followUpEnabled,
        followUpDelayMinutes: policy.followUpDelayMinutes,
        notifyOnInitialRecoveryOutreach,
      },
    });
  });
}
