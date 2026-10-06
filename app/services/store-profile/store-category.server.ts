import { CommerceAgentPromptScope, type Prisma } from "@prisma/client";
import db from "@/db.server";
import {
  localizeStoreCategory,
  localizeStoreCategoryMapping,
  storeCategoryTranslationLocales,
} from "./store-category-localization";
import { readStoreCategoryPromptSourceContext } from "./store-category-prompt-provenance";
import { resolveShopifyCommerceEnvironment } from "./store-category-activation.server";

type CategoryReader = Pick<
  typeof db,
  "commercePromptTemplateCategory" | "commerceShopProfile" | "commerceAgentConfiguration"
>;

type CategoryWithTranslations = {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  translations?: Array<{ locale: string; displayName: string; description: string }> | null;
};

export async function listSelectableStoreCategories(locale: string, client: CategoryReader = db) {
  const translationLocales = storeCategoryTranslationLocales(locale);
  const rows = await client.commercePromptTemplateCategory.findMany({
    where: { enabled: true, defaultTemplateId: { not: null } },
    include: {
      defaultTemplate: true,
      translations: { where: { locale: { in: translationLocales } } },
      taxonomyMappings: {
        where: { conditionKey: { not: null } },
        include: {
          translations: { where: { locale: { in: translationLocales } } },
        },
        orderBy: [{ weight: "desc" }, { id: "asc" }],
      },
    },
    orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
  });

  return rows.flatMap((category) => {
    const template = category.defaultTemplate;
    if (
      !template ||
      !template.enabled ||
      template.categoryId !== category.id ||
      !template.promptText.trim()
    ) return [];

    return [{
      id: category.id,
      slug: category.slug,
      ...localizeStoreCategory(category, locale),
      mappings: category.taxonomyMappings.flatMap((mapping) =>
        mapping.conditionKey
          ? [{
              id: mapping.id,
              conditionKey: mapping.conditionKey,
              ...localizeStoreCategoryMapping(mapping, locale),
            }]
          : [],
      ),
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
  const translationLocales = storeCategoryTranslationLocales(locale);
  const environment = resolveShopifyCommerceEnvironment();
  const [profile, configurations] = await Promise.all([
    client.commerceShopProfile.findUnique({
      where: { shopId },
      include: {
        activeCategory: {
          include: { translations: { where: { locale: { in: translationLocales } } } },
        },
        pendingCategory: {
          include: { translations: { where: { locale: { in: translationLocales } } } },
        },
        pendingPromptRevision: { include: { sourceTemplate: true } },
      },
    }),
    client.commerceAgentConfiguration.findMany({
      where: {
        environment,
        scope: CommerceAgentPromptScope.SHOP,
        shopId,
      },
      select: {
        activePromptRevision: { select: { sourceContext: true } },
      },
      take: 2,
    }),
  ]);
  const categoryDto = (category: CategoryWithTranslations | null | undefined) =>
    category ? {
      id: category.id,
      slug: category.slug,
      ...localizeStoreCategory(category, locale),
    } : null;
  const template = profile?.pendingPromptRevision?.sourceTemplate;
  const pendingSourceContext = readStoreCategoryPromptSourceContext(
    profile?.pendingPromptRevision?.sourceContext,
  );
  const activeSourceContext = configurations.length === 1
    ? readStoreCategoryPromptSourceContext(configurations[0]?.activePromptRevision?.sourceContext)
    : null;

  return {
    activeCategory: categoryDto(profile?.activeCategory),
    pendingCategory: categoryDto(profile?.pendingCategory),
    pendingSelectionGeneration: profile?.pendingSelectionGeneration ?? 0,
    activeMappingIds:
      activeSourceContext && activeSourceContext.categoryId === profile?.activeCategoryId
        ? activeSourceContext.mappings.map((mapping) => mapping.mappingId)
        : [],
    pendingMappingIds:
      pendingSourceContext && pendingSourceContext.categoryId === profile?.pendingCategoryId
        ? pendingSourceContext.mappings.map((mapping) => mapping.mappingId)
        : [],
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
