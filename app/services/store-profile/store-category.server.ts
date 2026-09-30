import type { Prisma } from "@prisma/client";
import db from "@/db.server";
import {
  hasStoreCategoryLocalization,
  localizeStoreCategory,
} from "./store-category-localization";

type CategoryReader = Pick<typeof db, "commercePromptTemplateCategory" | "commerceShopProfile">;
type LocalizedCategory = Parameters<typeof localizeStoreCategory>[0] & { id: string };

export async function listSelectableStoreCategories(locale: string, client: CategoryReader = db) {
  const rows = await client.commercePromptTemplateCategory.findMany({
    where: { enabled: true, defaultTemplateId: { not: null } },
    include: { defaultTemplate: true },
    orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
  });

  return rows.flatMap((category) => {
    const template = category.defaultTemplate;
    if (
      !template ||
      !template.enabled ||
      template.categoryId !== category.id ||
      !template.promptText.trim() ||
      !hasStoreCategoryLocalization(category.slug)
    ) return [];

    return [{
      id: category.id,
      slug: category.slug,
      ...localizeStoreCategory(category, locale),
      defaultTemplate: {
        id: template.id,
        key: template.key,
        displayName: template.displayName,
        editVersion: template.editVersion,
      },
    }];
  });
}

export async function loadStoreProfile(shopId: string, locale: string, client: CategoryReader = db) {
  const profile = await client.commerceShopProfile.findUnique({
    where: { shopId },
    include: {
      activeCategory: true,
      pendingCategory: true,
      pendingPromptRevision: { include: { sourceTemplate: true } },
    },
  });
  const categoryDto = (category: LocalizedCategory | null | undefined) =>
    category ? {
      id: category.id,
      slug: category.slug,
      ...localizeStoreCategory(category, locale),
    } : null;
  const template = profile?.pendingPromptRevision?.sourceTemplate;

  return {
    activeCategory: categoryDto(profile?.activeCategory),
    pendingCategory: categoryDto(profile?.pendingCategory),
    pendingSelectionGeneration: profile?.pendingSelectionGeneration ?? 0,
    pendingState: profile?.pendingPromptRevisionId ? "PENDING_PUBLICATION" : "NONE",
    pendingTemplate: template ? {
      id: template.id,
      key: template.key,
      displayName: template.displayName,
      editVersion: profile.pendingPromptRevision?.sourceTemplateEditVersion ?? null,
    } : null,
  };
}

export type StoreCategoryClient = typeof db | Prisma.TransactionClient;