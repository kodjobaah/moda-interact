import { createHash } from "node:crypto";
import {
  CommerceAgentPromptScope,
  CommercePromptRevisionStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import db from "@/db.server";
import {
  createStoreCategoryPromptContext,
  renderStoreCategoryPromptTemplate,
} from "@modainteract/moda-interact-shared/commerce";
import { resolveShopifyCommerceEnvironment } from "./store-category-activation.server";
import { createStoreCategoryPromptSourceContext } from "./store-category-prompt-provenance";

export type StoreCategorySelectionInput = {
  shopId: string;
  categoryId: string;
  expectedPendingSelectionGeneration: number;
  selectedMappingIds?: readonly string[];
};

export class StoreCategorySelectionError extends Error {
  constructor(readonly code: "CONFLICT" | "CATEGORY_UNAVAILABLE") {
    super(code);
    this.name = "StoreCategorySelectionError";
  }
}

const conflict = () => new StoreCategorySelectionError("CONFLICT");

type StoreCategorySelectionClient = Pick<
  PrismaClient,
  "$transaction" | "commerceShopProfile" | "commercePromptTemplateCategory"
>;

type PreparedStoreCategorySelection = {
  categoryId: string;
  categoryEditVersion: number;
  templateId: string;
  templateEditVersion: number;
  promptText: string;
  sourceContext: Prisma.InputJsonValue;
  selectedMappings: Array<{
    id: string;
    editVersion: number;
    conditionKey: string;
  }>;
};

async function prepareStoreCategorySelection(
  input: StoreCategorySelectionInput,
  client: StoreCategorySelectionClient,
): Promise<PreparedStoreCategorySelection> {
  const category = await client.commercePromptTemplateCategory.findUnique({
    where: { id: input.categoryId },
    include: {
      defaultTemplate: true,
      taxonomyMappings: {
        where: { conditionKey: { not: null } },
        orderBy: [{ weight: "desc" }, { id: "asc" }],
      },
    },
  });
  const template = category?.defaultTemplate;
  if (
    !category ||
    !category.enabled ||
    !template ||
    !template.enabled ||
    template.categoryId !== category.id ||
    !template.promptText.trim()
  ) throw new StoreCategorySelectionError("CATEGORY_UNAVAILABLE");

  const selectedMappingIds = [...(input.selectedMappingIds ?? [])];
  if (new Set(selectedMappingIds).size !== selectedMappingIds.length)
    throw new StoreCategorySelectionError("CATEGORY_UNAVAILABLE");
  const mappingById = new Map(category.taxonomyMappings.map((mapping) => [mapping.id, mapping]));
  const selectedMappings = selectedMappingIds.map((mappingId) => mappingById.get(mappingId));
  if (selectedMappings.some((mapping) => !mapping || !mapping.conditionKey))
    throw new StoreCategorySelectionError("CATEGORY_UNAVAILABLE");

  const availableConditionKeys = category.taxonomyMappings.flatMap((mapping) =>
    mapping.conditionKey ? [mapping.conditionKey] : [],
  );
  const selectedConditionKeys = selectedMappings.flatMap((mapping) =>
    mapping?.conditionKey ? [mapping.conditionKey] : [],
  );
  let renderedPrompt;
  try {
    renderedPrompt = renderStoreCategoryPromptTemplate({
      source: template.promptText,
      context: createStoreCategoryPromptContext({
        availableConditionKeys,
        selectedConditionKeys,
      }),
    });
  } catch {
    throw new StoreCategorySelectionError("CATEGORY_UNAVAILABLE");
  }
  if (!renderedPrompt.ok || !renderedPrompt.promptText.trim())
    throw new StoreCategorySelectionError("CATEGORY_UNAVAILABLE");

  const preparedMappings = selectedMappings.flatMap((mapping) =>
    mapping?.conditionKey
      ? [{ id: mapping.id, editVersion: mapping.editVersion, conditionKey: mapping.conditionKey }]
      : [],
  );

  return {
    categoryId: category.id,
    categoryEditVersion: category.editVersion,
    templateId: template.id,
    templateEditVersion: template.editVersion,
    promptText: renderedPrompt.promptText,
    sourceContext: createStoreCategoryPromptSourceContext({
      category: { id: category.id, editVersion: category.editVersion },
      template: { id: template.id, editVersion: template.editVersion },
      mappings: preparedMappings,
    }) as Prisma.InputJsonValue,
    selectedMappings: preparedMappings,
  };
}

async function assertPreparedSelectionStillCurrent(
  tx: Prisma.TransactionClient,
  prepared: PreparedStoreCategorySelection,
) {
  const category = await tx.commercePromptTemplateCategory.findUnique({
    where: { id: prepared.categoryId },
    select: {
      id: true,
      enabled: true,
      editVersion: true,
      defaultTemplateId: true,
      defaultTemplate: {
        select: {
          id: true,
          enabled: true,
          editVersion: true,
          categoryId: true,
        },
      },
      taxonomyMappings: {
        where: { id: { in: prepared.selectedMappings.map((mapping) => mapping.id) } },
        select: {
          id: true,
          categoryId: true,
          editVersion: true,
          conditionKey: true,
        },
      },
    },
  });
  const template = category?.defaultTemplate;
  if (
    !category ||
    !category.enabled ||
    category.editVersion !== prepared.categoryEditVersion ||
    category.defaultTemplateId !== prepared.templateId ||
    !template ||
    !template.enabled ||
    template.id !== prepared.templateId ||
    template.categoryId !== prepared.categoryId ||
    template.editVersion !== prepared.templateEditVersion
  ) throw conflict();

  const mappingById = new Map(category.taxonomyMappings.map((mapping) => [mapping.id, mapping]));
  if (prepared.selectedMappings.some((preparedMapping) => {
    const mapping = mappingById.get(preparedMapping.id);
    return !mapping ||
      mapping.categoryId !== prepared.categoryId ||
      mapping.editVersion !== preparedMapping.editVersion ||
      mapping.conditionKey !== preparedMapping.conditionKey;
  })) throw conflict();
}

export async function selectPendingStoreCategory(
  input: StoreCategorySelectionInput,
  client: StoreCategorySelectionClient = db,
  now = new Date(),
) {
  const existingProfile = await client.commerceShopProfile.findUnique({
    where: { shopId: input.shopId },
    select: { pendingSelectionGeneration: true },
  });
  if (
    (existingProfile && existingProfile.pendingSelectionGeneration !== input.expectedPendingSelectionGeneration) ||
    (!existingProfile && input.expectedPendingSelectionGeneration !== 0)
  ) throw conflict();

  const prepared = await prepareStoreCategorySelection(input, client);

  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${input.shopId} FOR UPDATE
    `);

    let profile = await tx.commerceShopProfile.findUnique({ where: { shopId: input.shopId } });
    if (!profile) profile = await tx.commerceShopProfile.create({ data: { shopId: input.shopId } });
    if (profile.pendingSelectionGeneration !== input.expectedPendingSelectionGeneration)
      throw conflict();

    await assertPreparedSelectionStillCurrent(tx, prepared);

    const lineages = await tx.commerceAgentPrompt.findMany({
      where: { scope: CommerceAgentPromptScope.SHOP, shopId: input.shopId },
      select: { id: true },
    });
    if (lineages.length > 1) throw conflict();
    const lineage = lineages[0] ?? await tx.commerceAgentPrompt.create({
      data: { scope: CommerceAgentPromptScope.SHOP, shopId: input.shopId },
      select: { id: true },
    });

    const nextGeneration = input.expectedPendingSelectionGeneration + 1;

    if (profile.activeCategoryId !== null) {
      const contentHash = createHash("sha256")
        .update(prepared.promptText, "utf8")
        .digest("hex");

      let revision;
      if (profile.pendingPromptRevisionId) {
        const pendingRevision = await tx.commerceAgentPromptRevision.findUnique({
          where: { id: profile.pendingPromptRevisionId },
          select: { id: true, promptId: true, revisionNumber: true, status: true },
        });
        if (
          !pendingRevision ||
          pendingRevision.promptId !== lineage.id ||
          pendingRevision.status !== CommercePromptRevisionStatus.DRAFT
        ) throw conflict();
        revision = await tx.commerceAgentPromptRevision.update({
          where: { id: pendingRevision.id },
          data: {
            status: CommercePromptRevisionStatus.PUBLISHED,
            promptText: prepared.promptText,
            sourceTemplateId: prepared.templateId,
            sourceTemplateEditVersion: prepared.templateEditVersion,
            sourceContext: prepared.sourceContext,
            contentHash,
            publishedAt: now,
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
            status: CommercePromptRevisionStatus.PUBLISHED,
            promptText: prepared.promptText,
            sourceTemplateId: prepared.templateId,
            sourceTemplateEditVersion: prepared.templateEditVersion,
            sourceContext: prepared.sourceContext,
            contentHash,
            publishedAt: now,
          },
          select: { id: true, revisionNumber: true },
        });
      }

      const environment = resolveShopifyCommerceEnvironment();
      const configurations = await tx.commerceAgentConfiguration.findMany({
        where: {
          environment,
          scope: CommerceAgentPromptScope.SHOP,
          shopId: input.shopId,
        },
        select: { id: true },
      });
      if (configurations.length > 1) throw conflict();
      if (configurations[0]) {
        await tx.commerceAgentConfiguration.update({
          where: { id: configurations[0].id },
          data: {
            activePromptRevisionId: revision.id,
            promptEditVersion: { increment: 1 },
          },
        });
      } else {
        await tx.commerceAgentConfiguration.create({
          data: {
            environment,
            scope: CommerceAgentPromptScope.SHOP,
            shopId: input.shopId,
            activePromptRevisionId: revision.id,
            promptEditVersion: 2,
          },
        });
      }

      const updated = await tx.commerceShopProfile.updateMany({
        where: {
          shopId: input.shopId,
          activeCategoryId: profile.activeCategoryId,
          pendingSelectionGeneration: input.expectedPendingSelectionGeneration,
        },
        data: {
          activeCategoryId: prepared.categoryId,
          activeCategoryActivatedAt: now,
          pendingCategoryId: null,
          pendingPromptRevisionId: null,
          pendingSelectedAt: null,
          pendingSelectionGeneration: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw conflict();

      return {
        activeCategoryId: prepared.categoryId,
        activePromptRevisionId: revision.id,
        pendingCategoryId: null,
        pendingPromptRevisionId: null,
        pendingSelectionGeneration: nextGeneration,
      };
    }

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
          promptText: prepared.promptText,
          sourceTemplateId: prepared.templateId,
          sourceTemplateEditVersion: prepared.templateEditVersion,
          sourceContext: prepared.sourceContext,
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
          promptText: prepared.promptText,
          sourceTemplateId: prepared.templateId,
          sourceTemplateEditVersion: prepared.templateEditVersion,
          sourceContext: prepared.sourceContext,
        },
        select: { id: true, revisionNumber: true },
      });
    }

    const updated = await tx.commerceShopProfile.updateMany({
      where: { shopId: input.shopId, pendingSelectionGeneration: input.expectedPendingSelectionGeneration },
      data: {
        pendingCategoryId: prepared.categoryId,
        pendingPromptRevisionId: revision.id,
        pendingSelectedAt: now,
        pendingSelectionGeneration: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw conflict();

    return {
      pendingCategoryId: prepared.categoryId,
      pendingPromptRevisionId: revision.id,
      pendingSelectionGeneration: nextGeneration,
    };
  });
}
