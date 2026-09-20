import { Prisma } from "@prisma/client";

import prisma from "../../db.server";

export const PROMOTION_SELECTION_ERROR_CODES = {
  ACTIVE_PROMOTION_ALREADY_SELECTED: "ACTIVE_PROMOTION_ALREADY_SELECTED",
  PROMOTION_NOT_ELIGIBLE: "PROMOTION_NOT_ELIGIBLE",
  PROMOTION_SELECTION_UNAVAILABLE: "PROMOTION_SELECTION_UNAVAILABLE",
} as const;

export const PROMOTION_HISTORY_PAGE_SIZE = 6;

export type PromotionHistoryStatus =
  | "SELECTED"
  | "USED"
  | "EXHAUSTED"
  | "EXPIRED"
  | "CLOSED"
  | "NO_LONGER_ELIGIBLE"
  | "REOPENED";

export type CurrentPromotionSelectionState = {
  campaignId: string;
  merchantTitle: string | null;
  expiresAt: Date;
  remainingQuantity: number;
  exhausted: boolean;
  campaignStatus: string;
  targetEligible: boolean;
  spendable: boolean;
  locked: boolean;
};

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

export function promotionHistoryStatus(
  grant: {
    quantity: number;
    reservedQuantity: number;
    committedQuantity: number;
    selectionCount: number;
    firstSelectedAt: Date | null;
    exhaustedAt: Date | null;
    firstUsedAt: Date | null;
    selection: { shopId: string } | null;
  },
  campaign: {
    status: string;
      scope: string;
    expiresAt: Date;
    targetPlanId: string | null;
    targetShopId: string | null;
  },
  shopId: string,
  planId: string | null,
  reopenedAt: Date | null = null,
  now = new Date(),
): PromotionHistoryStatus {
  if (grant.exhaustedAt) return "EXHAUSTED";
  if (campaign.status === "CLOSED") return "CLOSED";
  if (campaign.expiresAt <= now) return "EXPIRED";
  if (!isTargetEligible(campaign, shopId, planId)) return "NO_LONGER_ELIGIBLE";
  const remainingQuantity = Math.max(0, grant.quantity - grant.reservedQuantity - grant.committedQuantity);
  if (reopenedAt && grant.firstSelectedAt && reopenedAt > grant.firstSelectedAt && remainingQuantity > 0) return "REOPENED";
  return grant.firstUsedAt ? "USED" : "SELECTED";
}

export function projectPromotionHistoryRow(
  grant: {
    quantity: number;
    reservedQuantity: number;
    committedQuantity: number;
    selectionCount: number;
    firstSelectedAt: Date | null;
    lastSelectedAt: Date | null;
    firstUsedAt: Date | null;
    lastUsedAt: Date | null;
    exhaustedAt: Date | null;
    selection: { shopId: string } | null;
    campaign: {
      id: string;
      translations: Array<{ merchantTitle: string }>;
      scope: string;
      expiresAt: Date;
      status: string;
      targetPlanId: string | null;
      targetShopId: string | null;
      events?: Array<{ createdAt: Date }>;
    };
    reopenedAt?: Date | null;
  },
  shopId: string,
  planId: string | null,
  now = new Date(),
) {
  return {
    campaignId: grant.campaign.id,
    campaignTitle: grant.campaign.translations?.[0]?.merchantTitle ?? null,
    quantityGranted: grant.quantity,
    committedQuantity: grant.committedQuantity,
    remainingQuantity: Math.max(0, grant.quantity - grant.reservedQuantity - grant.committedQuantity),
    firstSelectedAt: grant.firstSelectedAt,
    lastSelectedAt: grant.lastSelectedAt,
    firstUsedAt: grant.firstUsedAt,
    lastUsedAt: grant.lastUsedAt,
    expiresAt: grant.campaign.expiresAt,
    currentlySelected: grant.selection !== null && grant.campaign.expiresAt > now,
    status: promotionHistoryStatus(grant, grant.campaign, shopId, planId, grant.reopenedAt, now),
  };
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
  translations: Array<{ merchantTitle: string; merchantDescription: string }>;
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
    selection: { shopId: string } | null;
  }>;
}, shopId: string, planId: string | null) {
  const grant = campaign.promotionalCreditGrants[0] ?? null;
  return {
    id: campaign.id,
    merchantTitle: campaign.translations[0].merchantTitle,
    merchantDescription: campaign.translations[0].merchantDescription,
    scope: campaign.scope,
    quantity: campaign.quantity,
    expiresAt: campaign.expiresAt,
    remainingQuantity: grant ? Math.max(0, grant.quantity - grant.reservedQuantity - grant.committedQuantity) : campaign.quantity,
    currentlySelected: Boolean(grant?.selection),
    previouslyClaimed: Boolean(grant),
    usable: isUsableGrant(grant),
    exhausted: Boolean(grant?.exhaustedAt) || (grant ? !isUsableGrant(grant) : false),
    eligible: isTargetEligible(campaign, shopId, planId),
  };
}

export async function getEligiblePromotionOffers(
  shopId: string,
  locale: string,
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
      translations: { where: { locale }, select: { merchantTitle: true, merchantDescription: true } },
      scope: true,
      quantity: true,
      startsAt: true,
      expiresAt: true,
      status: true,
      targetPlanId: true,
      targetShopId: true,
      promotionalCreditGrants: {
        where: { shopId },
        select: { quantity: true, reservedQuantity: true, committedQuantity: true, exhaustedAt: true, firstSelectedAt: true, lastSelectedAt: true, selection: { select: { shopId: true } } },
      },
    },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "desc" }],
  });
  return campaigns
    .filter((campaign: Parameters<typeof merchantOffer>[0]) => campaign.translations.length === 1)
    .map((campaign: Parameters<typeof merchantOffer>[0]) => merchantOffer(campaign, shopId, planId));
}

export async function getCurrentPromotionSelectionState(
  shopId: string,
  locale: string,
  now = new Date(),
  database: PromotionDatabase = prisma,
): Promise<CurrentPromotionSelectionState | null> {
  const context = await readContext(database, shopId);
  if (!context) return null;

  const selection = await database.merchantPromotionSelection.findUnique({
    where: { shopId },
    select: {
      promotionalCreditGrant: {
        select: {
          quantity: true,
          reservedQuantity: true,
          committedQuantity: true,
          exhaustedAt: true,
          campaign: {
            select: {
              id: true,
              status: true,
              startsAt: true,
              expiresAt: true,
              scope: true,
              targetPlanId: true,
              targetShopId: true,
              translations: { where: { locale }, select: { merchantTitle: true } },
            },
          },
        },
      },
    },
  });
  const grant = selection?.promotionalCreditGrant;
  if (!grant) return null;

  const remainingQuantity = Math.max(
    0,
    grant.quantity - grant.reservedQuantity - grant.committedQuantity,
  );
  const campaign = grant.campaign;
  const targetEligible = isTargetEligible(
    campaign,
    shopId,
    context.subscription?.planId ?? null,
  );
  const locked = campaign.expiresAt > now;

  return {
    campaignId: campaign.id,
    merchantTitle: campaign.translations[0]?.merchantTitle ?? null,
    expiresAt: campaign.expiresAt,
    remainingQuantity,
    exhausted: !isUsableGrant(grant),
    campaignStatus: campaign.status,
    targetEligible,
    spendable:
      campaign.status === "ACTIVE" &&
      campaign.startsAt <= now &&
      campaign.expiresAt > now &&
      targetEligible &&
      isUsableGrant(grant),
    locked,
  };
}

export async function getPromotionHistory(
  shopId: string,
  locale: string,
  page = 1,
  now = new Date(),
  database: PromotionDatabase = prisma,
) {
  const context = await readContext(database, shopId);
  if (!context) return { entries: [], page: 1, pageSize: PROMOTION_HISTORY_PAGE_SIZE, totalEntries: 0, totalPages: 1 };
  const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const where = { shopId };
  const [totalEntries, grants] = await Promise.all([
    database.promotionalCreditGrant.count({ where }),
    database.promotionalCreditGrant.findMany({
      where,
      orderBy: [{ lastSelectedAt: "desc" }, { createdAt: "desc" }],
      skip: (normalizedPage - 1) * PROMOTION_HISTORY_PAGE_SIZE,
      take: PROMOTION_HISTORY_PAGE_SIZE,
      select: {
        quantity: true,
        reservedQuantity: true,
        committedQuantity: true,
        selectionCount: true,
        firstSelectedAt: true,
        lastSelectedAt: true,
        firstUsedAt: true,
        lastUsedAt: true,
        exhaustedAt: true,
        selection: { select: { shopId: true } },
        campaign: {
          select: {
            id: true,
            translations: { where: { locale }, select: { merchantTitle: true } },
            scope: true,
            expiresAt: true,
            status: true,
            targetPlanId: true,
            targetShopId: true,
            events: {
              where: { kind: "REOPENED" },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { createdAt: true },
            },
          },
        },
      },
    }),
  ]);
  return {
    entries: grants.map((grant: Parameters<typeof projectPromotionHistoryRow>[0]) => projectPromotionHistoryRow({
      ...grant,
      reopenedAt: grant.campaign.events?.[0]?.createdAt ?? null,
    }, shopId, context.subscription?.planId ?? null, now)),
    page: normalizedPage,
    pageSize: PROMOTION_HISTORY_PAGE_SIZE,
    totalEntries,
    totalPages: Math.max(1, Math.ceil(totalEntries / PROMOTION_HISTORY_PAGE_SIZE)),
  };
}

export async function selectPromotionOffer(
  shopId: string,
  campaignId: string,
  now = new Date(),
  database: PromotionDatabase = prisma,
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await database.$transaction(async (transaction: Prisma.TransactionClient) => {
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
        include: {
          promotionalCreditGrant: {
            include: {
              campaign: {
                select: { id: true, status: true, startsAt: true, expiresAt: true, scope: true, targetPlanId: true, targetShopId: true },
              },
            },
          },
        },
      });
      const currentGrant = current?.promotionalCreditGrant ?? null;
      if (
        current
        && currentGrant
        && currentGrant.campaign.expiresAt > now
      ) {
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
      return { campaignId, remainingQuantity: Math.max(0, grant.quantity - grant.reservedQuantity - grant.committedQuantity) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof PromotionSelectionError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        if (attempt < 3) continue;
        throw new PromotionSelectionError("PROMOTION_SELECTION_UNAVAILABLE");
      }
      throw error;
    }
  }
  throw new PromotionSelectionError("PROMOTION_SELECTION_UNAVAILABLE");
}