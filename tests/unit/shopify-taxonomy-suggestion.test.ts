import { describe, expect, it, vi } from "vitest";
import {
  readShopifyTaxonomyCategoryIds,
  scoreStoreCategorySuggestion,
  SHOPIFY_TAXONOMY_PRODUCTS_QUERY,
  suggestStoreCategory,
} from "../../app/services/store-profile/shopify-taxonomy-suggestion.server";

describe("Shopify taxonomy category suggestion", () => {
  it("requests one deterministic page of at most 250 products and ignores uncategorized products", async () => {
    const admin = {
      graphql: vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            products: {
              nodes: [
                { category: { id: "gid://shopify/TaxonomyCategory/1" } },
                { category: null },
              ],
            },
          },
        }),
      })),
    };

    await expect(readShopifyTaxonomyCategoryIds(admin)).resolves.toEqual([
      "gid://shopify/TaxonomyCategory/1",
    ]);
    expect(admin.graphql).toHaveBeenCalledOnce();
    expect(admin.graphql).toHaveBeenCalledWith(SHOPIFY_TAXONOMY_PRODUCTS_QUERY);
    expect(SHOPIFY_TAXONOMY_PRODUCTS_QUERY).toContain("products(first: 250, sortKey: ID)");
    expect(SHOPIFY_TAXONOMY_PRODUCTS_QUERY).not.toContain("pageInfo");
  });

  it("returns the winning category together with its taxonomy evidence mappings", () => {
    const categories = [
      { id: "b", displayOrder: 1 },
      { id: "a", displayOrder: 2 },
      { id: "c", displayOrder: 1 },
    ];
    const mappings = [
      { id: "map-a-1", categoryId: "a", shopifyTaxonomyCategoryId: "tax-1", weight: 2 },
      { id: "map-b-2", categoryId: "b", shopifyTaxonomyCategoryId: "tax-2", weight: 2 },
      { id: "map-b-3", categoryId: "b", shopifyTaxonomyCategoryId: "tax-3", weight: 0 },
    ];

    expect(scoreStoreCategorySuggestion(categories, ["tax-1", "tax-1", "tax-2", "tax-3"], mappings)).toEqual({
      categoryId: "a",
      matchedMappingIds: ["map-a-1"],
    });
    expect(scoreStoreCategorySuggestion(categories, ["tax-1", "tax-2"], mappings)).toEqual({
      categoryId: "b",
      matchedMappingIds: ["map-b-2"],
    });
    expect(scoreStoreCategorySuggestion(categories, ["unknown"], mappings)).toEqual({
      categoryId: "b",
      matchedMappingIds: [],
    });
  });

  it("orders matched mappings by weighted catalogue evidence then id", () => {
    const categories = [{ id: "apparel", displayOrder: 0 }];
    const mappings = [
      { id: "shoes", categoryId: "apparel", shopifyTaxonomyCategoryId: "tax-shoes", weight: 1 },
      { id: "bags", categoryId: "apparel", shopifyTaxonomyCategoryId: "tax-bags", weight: 2 },
      { id: "hats", categoryId: "apparel", shopifyTaxonomyCategoryId: "tax-hats", weight: 1 },
    ];

    expect(scoreStoreCategorySuggestion(
      categories,
      ["tax-shoes", "tax-shoes", "tax-bags", "tax-hats"],
      mappings,
    )).toEqual({
      categoryId: "apparel",
      matchedMappingIds: ["bags", "shoes", "hats"],
    });
  });

  it("falls back to the first selectable category with no mapping evidence when Shopify evidence fails", async () => {
    const admin = { graphql: vi.fn(async () => { throw new Error("offline"); }) };
    await expect(suggestStoreCategory(admin, [{ id: "first" }, { id: "second" }])).resolves.toEqual({
      categoryId: "first",
      matchedMappingIds: [],
    });
  });
});
