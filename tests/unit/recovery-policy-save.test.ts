import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { saveMerchantRecoveryPolicy } from "../../app/services/recovery-policy/recovery-policy.server";

function persistence(
  currentPreference: boolean,
  updatedAt: Date,
  selectedIds: string[] = [],
  ownedIds = selectedIds,
) {
  const current = {
    recoveryDelayMinutes: 30,
    recoveryOfferMode: "NONE",
    fixedShopifyDiscountId: null,
    followUpEnabled: false,
    followUpDelayMinutes: null,
    notifyOnInitialRecoveryOutreach: currentPreference,
    updatedAt,
  };
  const transaction = {
    $queryRaw: vi.fn(async () => [{ id: "active-shop" }]),
    shopifyDiscount: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        (where.id
          ? ownedIds.filter((id) => where.id!.in.includes(id))
          : selectedIds
        ).map((id) => ({ id }))),
      updateMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) => ({
        count: where.id?.in.length ?? 0,
      })),
    },
    shopSettings: {
      findUniqueOrThrow: vi.fn(async () => current),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...current,
        ...data,
        updatedAt: new Date(updatedAt.getTime() + 1),
      })),
    },
    shopifyDiscountCatalogue: { findUnique: vi.fn() },
  };
  const client = {
    $transaction: (callback: (tx: typeof transaction) => unknown) => callback(transaction),
  } as unknown as PrismaClient;
  return { client, transaction };
}

const policyInput = (notifyOnInitialRecoveryOutreach: boolean) => ({
  recoveryDelayMinutes: "30",
  recoveryOfferMode: "NONE",
  selectedDiscountIds: [],
  followUpEnabled: "false",
  followUpDelayMinutes: "",
  notifyOnInitialRecoveryOutreach,
});

describe("initial recovery outreach preference persistence", () => {
  it.each([
    { current: false, next: true },
    { current: true, next: false },
  ])("persists preference-only changes from $current to $next", async ({ current, next }) => {
    const updatedAt = new Date("2026-10-27T12:00:00.000Z");
    const { client, transaction } = persistence(current, updatedAt);

    await saveMerchantRecoveryPolicy(
      "shop-123",
      policyInput(next),
      updatedAt.toISOString(),
      client,
    );

    expect(transaction.shopSettings.update).toHaveBeenCalledWith({
      where: { shopId: "shop-123" },
      data: expect.objectContaining({ notifyOnInitialRecoveryOutreach: next }),
    });
  });

  it("rejects a stale preference-only save with a conflict", async () => {
    const updatedAt = new Date("2026-10-27T12:00:00.000Z");
    const { client, transaction } = persistence(false, updatedAt);

    await expect(
      saveMerchantRecoveryPolicy(
        "shop-123",
        policyInput(true),
        "stale-revision",
        client,
      ),
    ).rejects.toMatchObject({ message: "CONFLICT" });
    expect(transaction.shopSettings.update).not.toHaveBeenCalled();
  });

  it("leaves unchanged preferences as a no-op", async () => {
    const updatedAt = new Date("2026-10-27T12:00:00.000Z");
    const { client, transaction } = persistence(false, updatedAt);

    const result = await saveMerchantRecoveryPolicy(
      "shop-123",
      policyInput(false),
      updatedAt.toISOString(),
      client,
    );

    expect(result.notifyOnInitialRecoveryOutreach).toBe(false);
    expect(transaction.shopSettings.update).not.toHaveBeenCalled();
    expect(transaction.shopifyDiscount.updateMany).toHaveBeenCalledTimes(2);
  });

  it("replaces a sorted multi-selection atomically and allows dormant provider states", async () => {
    const updatedAt = new Date("2026-10-27T12:00:00.000Z");
    const { client, transaction } = persistence(false, updatedAt, ["old"], ["a", "b", "old"]);
    const input = {
      ...policyInput(false),
      recoveryOfferMode: "FIXED",
      selectedDiscountIds: ["b", "a"],
    };

    await saveMerchantRecoveryPolicy("shop-123", input, updatedAt.toISOString(), client);

    expect(transaction.shopifyDiscount.updateMany).toHaveBeenNthCalledWith(1, {
      where: { shopId: "shop-123", isAvailable: true },
      data: { isAvailable: false },
    });
    expect(transaction.shopifyDiscount.updateMany).toHaveBeenNthCalledWith(2, {
      where: { shopId: "shop-123", id: { in: ["a", "b"] } },
      data: { isAvailable: true },
    });
    expect(transaction.shopSettings.update).toHaveBeenCalledWith({
      where: { shopId: "shop-123" },
      data: expect.objectContaining({ recoveryOfferMode: "FIXED", fixedShopifyDiscountId: "a" }),
    });
  });

  it("rejects cross-shop IDs before either availability update", async () => {
    const updatedAt = new Date("2026-10-27T12:00:00.000Z");
    const { client, transaction } = persistence(false, updatedAt, [], []);

    await expect(saveMerchantRecoveryPolicy("shop-123", {
      ...policyInput(false), selectedDiscountIds: ["foreign-discount"],
    }, updatedAt.toISOString(), client)).rejects.toMatchObject({
      code: "INVALID_DISCOUNT_SELECTION",
    });
    expect(transaction.shopifyDiscount.updateMany).not.toHaveBeenCalled();
    expect(transaction.shopSettings.update).not.toHaveBeenCalled();
  });

  it("checks stale revisions before all discount and settings writes", async () => {
    const updatedAt = new Date("2026-10-27T12:00:00.000Z");
    const { client, transaction } = persistence(false, updatedAt);

    await expect(saveMerchantRecoveryPolicy("shop-123", {
      ...policyInput(true), selectedDiscountIds: [],
    }, "stale", client)).rejects.toMatchObject({ message: "CONFLICT" });
    expect(transaction.shopifyDiscount.updateMany).not.toHaveBeenCalled();
    expect(transaction.shopSettings.update).not.toHaveBeenCalled();
  });
});
