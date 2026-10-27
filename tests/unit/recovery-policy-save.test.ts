import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { saveMerchantRecoveryPolicy } from "../../app/services/recovery-policy/recovery-policy.server";

function persistence(currentPreference: boolean, updatedAt: Date) {
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
      new Date(),
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
        new Date(),
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
      new Date(),
      updatedAt.toISOString(),
      client,
    );

    expect(result.notifyOnInitialRecoveryOutreach).toBe(false);
    expect(transaction.shopSettings.update).not.toHaveBeenCalled();
  });
});
