import { Prisma } from "@prisma/client";

import prisma from "../../db.server";

export const PROMOTION_SELECTION_ERROR_CODES = {
  ACTIVE_PROMOTION_ALREADY_SELECTED: "ACTIVE_PROMOTION_ALREADY_SELECTED",
  PROMOTION_NOT_ELIGIBLE: "PROMOTION_NOT_ELIGIBLE",
  PROMOTION_SELECTION_UNAVAILABLE: "PROMOTION_SELECTION_UNAVAILABLE",
} as const;

export class PromotionSelectionError extends Error {
  code: keyof typeof PROMOTION_SELECTION_ERROR_CODES;

  constructor(code: keyof typeof PROMOTION_SELECTION_ERROR_CODES) {
    super(code);
    this.name = "PromotionSelectionError";
    this.code = code;
  }
}

type PromotionDatabase = typeof prisma;

type PromotionContext = {
  shopId: string;
  shopStatus: string;
  subscription: {
    status: string;
    planId: string | null;
    plan: { id: string; name: string; active: boolean } | null;
  } | null;
};

function isExecutableSubscription(context: PromotionContext): boolean {
  return context.shopStatus === "ACTIVE" &&
    (context.subscription?.status === "ACTIVE" ||
      context.subscription?.status === "TRIALING") &&
    Boolean(context.subscription.plan?.active);
}

function isUsableGrant(grant: {
  quantity: number;
  reservedQuantity: number;
  committedQuantity: number;
  exhaustedAt: Date | null;
} | null): boolean {
  return Boolean(
    grant &&
    grant.exhaustedAt === null &&
    grant.quantity - grant.reservedQuantity - grant.committedQuantity > 0,
  );
}

function isTargetEligible(
  campaign: { scope: string; targetPlanId: string | null; targetShopId: string | null },
  shopId: string,
  planId: string | null,
): boolean {
  return campaign.scope === "GLOBAL" ||
    (campaign.scope === "SHOP" && campaign.targetShopId === shopId) ||
    (campaign.scope === "PLAN" && campaign.targetPlanId !== null && campaign.targetPlanId === planId);
}

async function readContext(database: PromotionDatabase, shopId: string): Promise<PromotionContext | null> {
  const shop = await database.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      status: true,
      subscription: {
        select: {
          status: true,
          planId: true,
          plan: { select: { id: true, name: true, active: true } },
        },
      },
    },
  });
  return shop ? { shopId: shop.id, shopStatus: shop.status, subscription: shop.subscription } : null;
}

function merchantOffer(campaign: {
  id: string;
  name: string;
  merchantDescription: string | null;
  scope: string;
  quantity: number;
  startsAt: Date;
  expiresAt: Date;
  status: string;
  targetPlanId: string | null;
  targetShopId: string | null;
  promotionalCreditGrants: Array<{
    quantity: number;
    reservedQuantity: number;
    committedQuantity: number;
    exhaustedAt: Date | null;
    firstSelectedAt: Date | null;
    lastSelectedAt: Date | null;
  }>;
}, shopId: string, planId: string | null) {
  const grant = campaign.promotionalCreditGrants[0] ?? null;
  return {
    id: campaign.id,
    name: campaign.name,
    merchantDescription: campaign.merchantDescription,
    scope: campaign.scope,
    quantity: campaign.quantity,
    expiresAt: campaign.expiresAt,
    remainingQuantity: grant ? Math.max(0, grant.quantity - grant.reservedQuantity - grant.committedQuantity) : campaign.quantity,
    selected: Boolean(grant),
    usable: isUsableGrant(grant),
    exhausted: Boolean(grant?.exhaustedAt) || (grant ? !isUsableGrant(grant) : false),
    eligible: isTargetEligible(campaign, shopId, planId),
  };
}

export async function getEligiblePromotionOffers(
  shopId: string,
  now = new Date(),
  database: PromotionDatabase = prisma,
) {
  const context = await readContext(database, shopId);
  if (!context) return [];
  const planId = context.subscription?.planId ?? null;
  const campaigns = await database.promotionCampaign.findMany({
    where: {
      status: "ACTIVE",
      startsAt: { lte: now },
      expiresAt: { gt: now },
      OR: [
        { scope: "GLOBAL" },
        { scope: "SHOP", targetShopId: shopId },
        ...(planId ? [{ scope: "PLAN" as const, targetPlanId: planId }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      merchantDescription: true,
      scope: true,
      quantity: true,
      startsAt: true,
      expiresAt: true,
      status: true,
      targetPlanId: true,
      targetShopId: true,
      promotionalCreditGrants: {
        where: { shopId },
        select: { quantity: true, reservedQuantity: true, committedQuantity: true, exhaustedAt: true, firstSelectedAt: true, lastSelectedAt: true },
      },
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "desc" }],
  });
  return campaigns.map((campaign) => merchantOffer(campaign, shopId, planId));
}

export async function selectPromotionOffer(
  shopId: string,
  campaignId: string,
  now = new Date(),
  database: PromotionDatabase = prisma,
) {
  try {
    return await database.$transaction(async (transaction) => {
      const context = await readContext(transaction, shopId);
      if (!context || !isExecutableSubscription(context)) {
        throw new PromotionSelectionError("PROMOTION_SELECTION_UNAVAILABLE");
      }

      const campaign = await transaction.promotionCampaign.findUnique({
        where: { id: campaignId },
        select: {
          id: true,
          name: true,
          merchantDescription: true,
          scope: true,
          quantity: true,
          startsAt: true,
          expiresAt: true,
          status: true,
          targetPlanId: true,
          targetShopId: true,
        },
      });
      if (!campaign || campaign.status !== "ACTIVE" || campaign.startsAt > now || campaign.expiresAt <= now || !isTargetEligible(campaign, shopId, context.subscription?.planId ?? null)) {
        throw new PromotionSelectionError("PROMOTION_NOT_ELIGIBLE");
      }

      const current = await transaction.merchantPromotionSelection.findUnique({
        where: { shopId },
        include: { promotionalCreditGrant: true },
      });
      const currentGrant = current?.promotionalCreditGrant ?? null;
      if (current && current.promotionalCreditGrant.campaignId !== campaignId && isUsableGrant(currentGrant) && currentGrant.campaign.expiresAt > now && currentGrant.campaign.status === "ACTIVE") {
        throw new PromotionSelectionError("ACTIVE_PROMOTION_ALREADY_SELECTED");
      }

      const grant = await transaction.promotionalCreditGrant.upsert({
        where: { campaignId_shopId: { campaignId, shopId } },
        update: {},
        create: { campaignId, shopId, quantity: campaign.quantity },
      });
      await transaction.promotionalCreditGrant.update({
        where: { id_shopId: { id: grant.id, shopId } },
        data: {
          firstSelectedAt: grant.firstSelectedAt ?? now,
          lastSelectedAt: now,
          selectionCount: { increment: 1 },
        },
      });
      await transaction.merchantPromotionSelection.upsert({
        where: { shopId },
        update: { promotionalCreditGrantId: grant.id },
        create: { shopId, promotionalCreditGrantId: grant.id },
      });
      return { campaignId, grantId: grant.id, remainingQuantity: Math.max(0, grant.quantity - grant.reservedQuantity - grant.committedQuantity) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof PromotionSelectionError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new PromotionSelectionError("ACTIVE_PROMOTION_ALREADY_SELECTED");
    }
    throw error;
  }
}