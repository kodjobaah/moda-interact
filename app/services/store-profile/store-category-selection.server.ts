import {
  CommerceAgentPromptScope,
  CommercePromptRevisionStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import db from "@/db.server";
import { hasStoreCategoryLocalization } from "./store-category-localization";

export type StoreCategorySelectionInput = {
  shopId: string;
  categoryId: string;
  expectedPendingSelectionGeneration: number;
};

export class StoreCategorySelectionError extends Error {
  constructor(readonly code: "CONFLICT" | "CATEGORY_UNAVAILABLE") {
    super(code);
    this.name = "StoreCategorySelectionError";
  }
}

const conflict = () => new StoreCategorySelectionError("CONFLICT");

export async function selectPendingStoreCategory(
  input: StoreCategorySelectionInput,
  client: Pick<PrismaClient, "$transaction"> = db,
  now = new Date(),
) {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${input.shopId} FOR UPDATE
    `);

    let profile = await tx.commerceShopProfile.findUnique({ where: { shopId: input.shopId } });
    if (!profile) profile = await tx.commerceShopProfile.create({ data: { shopId: input.shopId } });
    if (profile.pendingSelectionGeneration !== input.expectedPendingSelectionGeneration)
      throw conflict();

    const category = await tx.commercePromptTemplateCategory.findUnique({
      where: { id: input.categoryId },
      include: { defaultTemplate: true },
    });
    const template = category?.defaultTemplate;
    if (
      !category ||
      !category.enabled ||
      !template ||
      !template.enabled ||
      template.categoryId !== category.id ||
      !template.promptText.trim() ||
      !hasStoreCategoryLocalization(category.slug)
    ) throw new StoreCategorySelectionError("CATEGORY_UNAVAILABLE");

    const lineages = await tx.commerceAgentPrompt.findMany({
      where: { scope: CommerceAgentPromptScope.SHOP, shopId: input.shopId },
      select: { id: true },
    });
    if (lineages.length > 1) throw conflict();
    const lineage = lineages[0] ?? await tx.commerceAgentPrompt.create({
      data: { scope: CommerceAgentPromptScope.SHOP, shopId: input.shopId },
      select: { id: true },
    });

    let revision;
    if (profile.pendingPromptRevisionId) {
      revision = await tx.commerceAgentPromptRevision.findUnique({
        where: { id: profile.pendingPromptRevisionId },
        select: { id: true, promptId: true, revisionNumber: true, status: true, editVersion: true },
      });
      if (
        !revision ||
        revision.promptId !== lineage.id ||
        revision.status !== CommercePromptRevisionStatus.DRAFT
      ) throw conflict();
      revision = await tx.commerceAgentPromptRevision.update({
        where: { id: revision.id },
        data: {
          promptText: template.promptText,
          sourceTemplateId: template.id,
          sourceTemplateEditVersion: template.editVersion,
          editVersion: { increment: 1 },
        },
        select: { id: true, revisionNumber: true },
      });
    } else {
      const existingDraft = await tx.commerceAgentPromptRevision.findFirst({
        where: { promptId: lineage.id, status: CommercePromptRevisionStatus.DRAFT },
        select: { id: true },
      });
      if (existingDraft) throw conflict();
      const latestRevision = await tx.commerceAgentPromptRevision.findFirst({
        where: { promptId: lineage.id },
        orderBy: { revisionNumber: "desc" },
        select: { revisionNumber: true },
      });
      revision = await tx.commerceAgentPromptRevision.create({
        data: {
          promptId: lineage.id,
          revisionNumber: (latestRevision?.revisionNumber ?? 0) + 1,
          status: CommercePromptRevisionStatus.DRAFT,
          promptText: template.promptText,
          sourceTemplateId: template.id,
          sourceTemplateEditVersion: template.editVersion,
        },
        select: { id: true, revisionNumber: true },
      });
    }

    const updated = await tx.commerceShopProfile.updateMany({
      where: { shopId: input.shopId, pendingSelectionGeneration: input.expectedPendingSelectionGeneration },
      data: {
        pendingCategoryId: category.id,
        pendingPromptRevisionId: revision.id,
        pendingSelectedAt: now,
        pendingSelectionGeneration: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw conflict();

    return {
      pendingCategoryId: category.id,
      pendingPromptRevisionId: revision.id,
      pendingSelectionGeneration: input.expectedPendingSelectionGeneration + 1,
    };
  });
}