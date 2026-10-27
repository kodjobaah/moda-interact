import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { loadRecoveryPolicySnapshot } from "../../app/services/recovery-policy/recovery-policy.server";

it("projects the initial outreach notification as a top-level default-off setting", async () => {
  const client = {
    shopSettings: {
      findUnique: vi.fn(async () => ({
        recoveryDelayMinutes: 30,
        recoveryOfferMode: "NONE",
        fixedShopifyDiscountId: null,
        followUpEnabled: false,
        followUpDelayMinutes: null,
        notifyOnInitialRecoveryOutreach: undefined,
        updatedAt: new Date("2026-10-27T12:00:00.000Z"),
      })),
    },
    shopRecoveryPolicyOverride: { findFirst: vi.fn(async () => null) },
    shopifyDiscountCatalogue: { findUnique: vi.fn(async () => null) },
  } as unknown as PrismaClient;

  const snapshot = await loadRecoveryPolicySnapshot("shop-123", new Date(), client);

  expect(snapshot.notifyOnInitialRecoveryOutreach).toBe(false);
  expect(snapshot.merchant).not.toHaveProperty("notifyOnInitialRecoveryOutreach");
  expect(snapshot.effective).not.toHaveProperty("notifyOnInitialRecoveryOutreach");
});
