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

  it("sums repeated taxonomy evidence and resolves equal scores by display order then id", () => {
    const categories = [
      { id: "b", displayOrder: 1 },
      { id: "a", displayOrder: 2 },
      { id: "c", displayOrder: 1 },
    ];
    const mappings = [
      { categoryId: "a", shopifyTaxonomyCategoryId: "tax-1", weight: 2 },
      { categoryId: "b", shopifyTaxonomyCategoryId: "tax-2", weight: 2 },
      { categoryId: "b", shopifyTaxonomyCategoryId: "tax-3", weight: 0 },
    ];

    expect(scoreStoreCategorySuggestion(categories, ["tax-1", "tax-1", "tax-2", "tax-3"], mappings)).toBe("a");
    expect(scoreStoreCategorySuggestion(categories, ["tax-1", "tax-2"], mappings)).toBe("b");
    expect(scoreStoreCategorySuggestion(categories, ["unknown"], mappings)).toBe("b");
  });

  it("falls back to the first selectable category when Shopify evidence fails", async () => {
    const admin = { graphql: vi.fn(async () => { throw new Error("offline"); }) };
    await expect(suggestStoreCategory(admin, [{ id: "first" }, { id: "second" }])).resolves.toBe("first");
  });
});