import { describe, expect, it, vi } from "vitest";
import { mapShopifyUsageEventHandles } from "../../../../app/services/billing/shopify-usage-event-mapping";

describe("Shopify usage-event catalogue mapping", () => {
  function fixture(
    catalogue: { usageEvents: { eventHandle: string }[] } | null,
  ) {
    const findUnique = vi.fn().mockResolvedValue(catalogue);
    const transaction = { merchantPricingPlan: { findUnique } };
    return { transaction, findUnique };
  }

  it("maps only returned exact handles, ignores catalogue-only events and sorts/deduplicates", async () => {
    const { transaction, findUnique } = fixture({
      usageEvents: [
        { eventHandle: "silver" },
        { eventHandle: "bronze" },
        { eventHandle: "catalogue-only" },
      ],
    });
    await expect(
      mapShopifyUsageEventHandles(transaction as never, "starter", [
        "gold",
        "bronze",
        "gold",
        "silver",
        "Gold",
        "bronze",
      ]),
    ).resolves.toEqual({
      mappedHandles: ["bronze", "silver"],
      unmappedHandles: ["Gold", "gold"],
    });
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { shopifyPlanHandle: "starter" },
      select: { usageEvents: { select: { eventHandle: true } } },
    });
  });

  it.each([null, { usageEvents: [] }])(
    "treats an absent/empty catalogue as unmapped (%j)",
    async (catalogue) => {
      const { transaction } = fixture(catalogue);
      await expect(
        mapShopifyUsageEventHandles(transaction as never, "unknown", [
          "silver",
          "bronze",
          "silver",
        ]),
      ).resolves.toEqual({
        mappedHandles: [],
        unmappedHandles: ["bronze", "silver"],
      });
    },
  );

  it("does not read the catalogue when Shopify returned no events", async () => {
    const { transaction, findUnique } = fixture(null);
    await expect(
      mapShopifyUsageEventHandles(transaction as never, "starter", []),
    ).resolves.toEqual({ mappedHandles: [], unmappedHandles: [] });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("propagates the original Prisma failure unchanged", async () => {
    const cause = new Error("Prisma P2028 transaction not found");
    const { transaction, findUnique } = fixture(null);
    findUnique.mockRejectedValue(cause);
    await expect(
      mapShopifyUsageEventHandles(transaction as never, "starter", ["bronze"]),
    ).rejects.toBe(cause);
  });
});
