import db from "@/db.server";

export const SHOPIFY_TAXONOMY_PRODUCTS_QUERY = `query ModaStoreCategorySuggestionProducts {
  products(first: 250, sortKey: ID) {
    nodes {
      category {
        id
      }
    }
  }
}`;

type Category = { id: string; displayOrder?: number };
type TaxonomyMapping = {
  categoryId: string;
  shopifyTaxonomyCategoryId: string;
  weight: number;
};
type AdminGraphqlClient = {
  graphql(query: string): Promise<{
    ok?: boolean;
    json(): Promise<unknown>;
  }>;
};
type MappingReader = Pick<typeof db, "commerceStoreCategoryTaxonomyMapping">;

export async function readShopifyTaxonomyCategoryIds(admin: AdminGraphqlClient) {
  const response = await admin.graphql(SHOPIFY_TAXONOMY_PRODUCTS_QUERY);
  if (response.ok === false) throw new Error("Shopify taxonomy evidence unavailable");
  const payload = await response.json() as {
    data?: { products?: { nodes?: Array<{ category?: { id?: unknown } | null }> } };
    errors?: unknown[];
  };
  if (payload.errors?.length || !Array.isArray(payload.data?.products?.nodes))
    throw new Error("Shopify taxonomy evidence unavailable");
  return payload.data.products.nodes.flatMap((product) =>
    typeof product.category?.id === "string" && product.category.id.length > 0
      ? [product.category.id]
      : [],
  );
}

export function scoreStoreCategorySuggestion(
  categories: Category[],
  taxonomyCategoryIds: string[],
  mappings: TaxonomyMapping[],
) {
  if (!categories.length) return null;
  const selectableIds = new Set(categories.map((category) => category.id));
  const displayOrder = new Map(categories.map((category, index) => [
    category.id,
    category.displayOrder ?? index,
  ]));
  const mappingByTaxonomyId = new Map(
    mappings
      .filter((mapping) => selectableIds.has(mapping.categoryId) && mapping.weight > 0)
      .map((mapping) => [mapping.shopifyTaxonomyCategoryId, mapping]),
  );
  const scores = new Map<string, number>();
  for (const taxonomyId of taxonomyCategoryIds) {
    const mapping = mappingByTaxonomyId.get(taxonomyId);
    if (mapping)
      scores.set(mapping.categoryId, (scores.get(mapping.categoryId) ?? 0) + mapping.weight);
  }
  return [...categories].sort((left, right) =>
    (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) ||
    (displayOrder.get(left.id) ?? 0) - (displayOrder.get(right.id) ?? 0) ||
    left.id.localeCompare(right.id, "en"),
  )[0].id;
}

export async function suggestStoreCategory(
  admin: AdminGraphqlClient,
  categories: Category[],
  client: MappingReader = db,
) {
  if (!categories.length) return null;
  try {
    const taxonomyCategoryIds = await readShopifyTaxonomyCategoryIds(admin);
    const mappings = await client.commerceStoreCategoryTaxonomyMapping.findMany({
      where: {
        categoryId: { in: categories.map((category) => category.id) },
        shopifyTaxonomyCategoryId: { in: [...new Set(taxonomyCategoryIds)] },
        weight: { gt: 0 },
      },
      select: { categoryId: true, shopifyTaxonomyCategoryId: true, weight: true },
    });
    return scoreStoreCategorySuggestion(categories, taxonomyCategoryIds, mappings);
  } catch {
    return categories[0].id;
  }
}