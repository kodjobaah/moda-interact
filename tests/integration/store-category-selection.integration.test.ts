import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  resolveShop: vi.fn(),
  assertActiveShop: vi.fn(),
  selectPendingStoreCategory: vi.fn(),
}));

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: dependencies.authenticate },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: dependencies.resolveShop },
}));
vi.mock("../../app/services/shop/shop-access-policy", () => ({
  assertActiveShop: dependencies.assertActiveShop,
}));
vi.mock("../../app/services/store-profile/store-category-selection.server", () => ({
  selectPendingStoreCategory: dependencies.selectPendingStoreCategory,
  StoreCategorySelectionError: class StoreCategorySelectionError extends Error {
    constructor(readonly code: "CONFLICT" | "CATEGORY_UNAVAILABLE") {
      super(code);
    }
  },
}));

import { action } from "../../app/routes/app/store-profile/category/route";

describe("Store Category selection action", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dependencies.authenticate.mockResolvedValue({ admin: {}, session: { shop: "merchant.myshopify.com" } });
    dependencies.resolveShop.mockResolvedValue({ id: "shop-123" });
    dependencies.selectPendingStoreCategory.mockResolvedValue({
      pendingCategoryId: "category-1",
      pendingPromptRevisionId: "draft-1",
      pendingSelectionGeneration: 5,
    });
  });

  it("scopes the shared transaction to the authenticated shop and accepts bounded mapping selections", async () => {
    const request = new Request("https://app.example/app/store-profile/category", {
      method: "POST",
      body: new URLSearchParams([
        ["categoryId", "category-1"],
        ["expectedPendingSelectionGeneration", "4"],
        ["mappingId", "mapping-shoes"],
        ["mappingId", "mapping-handbags"],
      ]),
    });

    const response = await action({ request } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      pendingCategoryId: "category-1",
      pendingPromptRevisionId: "draft-1",
      pendingSelectionGeneration: 5,
    });
    expect(dependencies.resolveShop).toHaveBeenCalledWith({ admin: {}, domain: "merchant.myshopify.com" });
    expect(dependencies.assertActiveShop).toHaveBeenCalledOnce();
    expect(dependencies.selectPendingStoreCategory).toHaveBeenCalledWith({
      shopId: "shop-123",
      categoryId: "category-1",
      expectedPendingSelectionGeneration: 4,
      selectedMappingIds: ["mapping-shoes", "mapping-handbags"],
    });
  });

  it.each([
    new URLSearchParams([
      ["categoryId", "category-1"],
      ["categoryId", "category-2"],
      ["expectedPendingSelectionGeneration", "0"],
    ]),
    new URLSearchParams({ categoryId: "category-1", expectedPendingSelectionGeneration: "0", templateId: "untrusted" }),
    new URLSearchParams({ categoryId: "category-1", expectedPendingSelectionGeneration: "-1" }),
    new URLSearchParams({ categoryId: "category-1", expectedPendingSelectionGeneration: "1.5" }),
    new URLSearchParams([
      ["categoryId", "category-1"],
      ["expectedPendingSelectionGeneration", "0"],
      ["mappingId", "mapping-1"],
      ["mappingId", "mapping-1"],
    ]),
  ])("rejects malformed or untrusted form fields", async (body) => {
    const response = await action({
      request: new Request("https://app.example/app/store-profile/category", { method: "POST", body }),
    } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    expect(dependencies.selectPendingStoreCategory).not.toHaveBeenCalled();
  });
});