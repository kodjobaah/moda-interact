import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { loadRecoveryPolicySnapshot } from "../../app/services/recovery-policy/recovery-policy.server";

it("returns selected IDs and provider catalogue facts independently from effective Admin policy", async () => {
  const updatedAt = new Date("2026-10-27T12:00:00.000Z");
  const client = {
    shopSettings: {
      findUnique: vi.fn(async () => ({
        recoveryDelayMinutes: 30,
        recoveryOfferMode: "NONE",
        fixedShopifyDiscountId: null,
        followUpEnabled: false,
        followUpDelayMinutes: null,
        notifyOnInitialRecoveryOutreach: undefined,
        updatedAt,
      })),
    },
    shopRecoveryPolicyOverride: {
      findFirst: vi.fn(async () => ({
        recoveryDelayMinutes: 45,
        recoveryOfferMode: "AI_BEST_APPLICABLE",
        fixedShopifyDiscountId: null,
        followUpEnabled: false,
        followUpDelayMinutes: null,
      })),
    },
    shopifyDiscountCatalogue: {
      findUnique: vi.fn(async () => ({
        status: "ERROR",
        syncGeneration: 8,
        discounts: [{
          id: "dormant",
          title: "Dormant",
          summary: null,
          method: "CODE",
          providerStatus: "EXPIRED",
          startsAt: null,
          endsAt: null,
          singleRedeemCode: null,
          fixedSelectable: false,
          isAvailable: true,
          unavailableAt: new Date("2026-10-01T00:00:00.000Z"),
          lastSyncedAt: new Date("2026-10-02T00:00:00.000Z"),
          lastSeenSyncGeneration: 7,
        }, {
          id: "new-sync",
          title: "New sync",
          summary: null,
          method: "AUTOMATIC",
          providerStatus: "ACTIVE",
          startsAt: null,
          endsAt: null,
          singleRedeemCode: null,
          fixedSelectable: true,
          isAvailable: false,
          unavailableAt: null,
          lastSyncedAt: new Date("2026-10-03T00:00:00.000Z"),
          lastSeenSyncGeneration: 8,
        }],
      })),
    },
  } as unknown as PrismaClient;

  const snapshot = await loadRecoveryPolicySnapshot("shop-123", new Date(), client);

  expect(snapshot.notifyOnInitialRecoveryOutreach).toBe(false);
  expect(snapshot.merchant).not.toHaveProperty("notifyOnInitialRecoveryOutreach");
  expect(snapshot.effective).not.toHaveProperty("notifyOnInitialRecoveryOutreach");
  expect(snapshot.selectedDiscountIds).toEqual(["dormant"]);
  expect(snapshot.catalogueStatus).toBe("ERROR");
  expect(snapshot.catalogueGeneration).toBe(8);
  expect(snapshot.discounts.map((discount) => discount.id)).toEqual(["dormant", "new-sync"]);
  expect(snapshot.discounts[0]).toMatchObject({ providerStatus: "EXPIRED", isAvailable: true });
  expect(snapshot.discounts[1]).toMatchObject({ providerStatus: "ACTIVE", isAvailable: false });
  expect(snapshot.merchant.recoveryOfferMode).toBe("NONE");
  expect(snapshot.effective.recoveryOfferMode).toBe("AI_BEST_APPLICABLE");
  expect(snapshot.effective.source).toBe("ADMIN_OVERRIDE");
});
