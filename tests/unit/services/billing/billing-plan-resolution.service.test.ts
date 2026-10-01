import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const providerRead = vi.hoisted(() => vi.fn());
vi.mock("../../../../app/services/merchant-pricing/merchant-pricing.server.js", () => ({
  readMerchantPricingPlanForProvider: providerRead,
}));

import { BillingPlanResolutionService } from "../../../../app/services/billing/billing-plan-resolution.service";

afterEach(() => {
  vi.restoreAllMocks();
  providerRead.mockReset();
});

function checkoutRecoveryFeature() {
  return {
    featureId: "checkout-recovery",
    configuration: { enabledFor: ["checkout"] },
    feature: { key: "checkout_recovery", systemRequired: true },
  };
}

function cataloguePlan(overrides: Record<string, unknown> = {}) {
  return {
    shopifyPlanHandle: "growth",
    displayName: "Growth",
    planKind: "FREE",
    isActive: true,
    includedRecoveryCredits: 0,
    shopifyRecoveryUsageEventHandle: null,
    materializedAt: null,
    features: [checkoutRecoveryFeature()],
    ...overrides,
  };
}

function createResolutionService(options: {
  existingPlan?: Record<string, unknown> | null;
  catalogue?: Record<string, unknown> | null;
  compatibilityRows?: Array<{ purpose: { key: string }; dataFormat: { key: string } }>;
  createPlan?: ReturnType<typeof vi.fn>;
  merchantPlanFindUnique?: ReturnType<typeof vi.fn>;
  transactions?: ReturnType<typeof vi.fn>;
} = {}) {
  const createPlan = options.createPlan ?? vi.fn().mockResolvedValue({
    id: "billing-plan-1",
    shopifyPlanHandle: "growth",
    active: true,
    kind: "FREE",
  });
  const tx = {
    billingPlan: {
      findUnique: vi.fn().mockResolvedValue(options.existingPlan ?? null),
      create: createPlan,
    },
    merchantPricingPlan: {
      findUnique: options.merchantPlanFindUnique ?? vi.fn().mockResolvedValue(options.catalogue ?? cataloguePlan()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    merchantKnowledgePurposeDataFormat: {
      findMany: vi.fn().mockResolvedValue(options.compatibilityRows ?? [{
        purpose: { key: "FAQ" },
        dataFormat: { key: "WEB_PAGE" },
      }]),
    },
  };
  const transact = options.transactions ?? vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx));
  const database = {
    $transaction: transact,
    billingPlan: tx.billingPlan,
    merchantPricingPlan: tx.merchantPricingPlan,
  };
  return {
    service: new BillingPlanResolutionService(database as unknown as PrismaClient),
    database,
    tx,
    createPlan,
  };
}

describe("BillingPlanResolutionService", () => {
  it("reuses an active operational plan and marks an unmaterialized catalogue row", async () => {
    const existingPlan = { id: "billing-plan-existing", active: true };
    const { service, database, tx } = createResolutionService({
      existingPlan,
      merchantPlanFindUnique: vi.fn().mockResolvedValue({ materializedAt: null }),
    });

    const result = await service.resolveOrMaterializeBillingPlan("growth");

    expect(result).toEqual({ kind: "READY", plan: existingPlan, materialized: false });
    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.merchantPricingPlan.updateMany).toHaveBeenCalledWith({
      where: { shopifyPlanHandle: "growth", materializedAt: null },
      data: { materializedAt: expect.any(Date) },
    });
  });

  it("materializes a valid catalogue plan and marks its catalogue row", async () => {
    const { service, tx, createPlan } = createResolutionService();

    const result = await service.resolveOrMaterializeBillingPlan("growth");

    expect(result).toEqual({
      kind: "READY",
      plan: expect.objectContaining({ id: "billing-plan-1" }),
      materialized: true,
    });
    expect(createPlan).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopifyPlanHandle: "growth",
        kind: "FREE",
        shopifyUsageEventHandle: null,
        features: { create: [{ featureId: "checkout-recovery", enabled: true, configuration: { enabledFor: ["checkout"] } }] },
      }),
    });
    expect(tx.merchantPricingPlan.updateMany).toHaveBeenCalledTimes(1);
  });

  it("returns unknown and inactive outcomes without materializing", async () => {
    const unknown = createResolutionService({ catalogue: { ...cataloguePlan(), isActive: false } });
    await expect(unknown.service.resolveOrMaterializeBillingPlan("growth"))
      .resolves.toEqual({ kind: "UNKNOWN_CATALOGUE_PLAN" });

    const inactivePlan = { id: "billing-plan-inactive", active: false };
    const inactive = createResolutionService({ existingPlan: inactivePlan });
    await expect(inactive.service.resolveOrMaterializeBillingPlan("growth"))
      .resolves.toEqual({ kind: "INACTIVE_OPERATIONAL_PLAN", planId: inactivePlan.id });
    expect(inactive.createPlan).not.toHaveBeenCalled();
  });

  it("rejects Merchant Knowledge source pairs absent from active compatibility rows", async () => {
    const configuration = {
      schemaVersion: 1,
      maxKnowledgeSources: 10,
      maxContentUnitsPerSource: 1000,
      allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }],
    };
    const { service, tx, createPlan } = createResolutionService({
      catalogue: cataloguePlan({
        features: [checkoutRecoveryFeature(), {
          featureId: "merchant-knowledge",
          configuration,
          feature: { key: "merchant_knowledge", systemRequired: false },
        }],
      }),
      compatibilityRows: [],
    });

    await expect(service.resolveOrMaterializeBillingPlan("growth")).resolves.toEqual({
      kind: "INVALID_CATALOGUE_PLAN",
      reason: "INVALID_MERCHANT_KNOWLEDGE_CONFIGURATION",
    });
    expect(tx.merchantKnowledgePurposeDataFormat.findMany).toHaveBeenCalledTimes(1);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("recovers a unique-handle create race and preserves materializedAt repair", async () => {
    const winner = { id: "winner", active: true };
    const findPlan = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const createPlan = vi.fn().mockRejectedValue({ code: "P2002" });
    const findCatalogue = vi.fn()
      .mockResolvedValueOnce(cataloguePlan())
      .mockResolvedValueOnce({ materializedAt: null });
    const transactions = vi.fn(async (callback: (transaction: unknown) => unknown) => callback({
      billingPlan: { findUnique: findPlan, create: createPlan },
      merchantPricingPlan: {
        findUnique: findCatalogue,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      merchantKnowledgePurposeDataFormat: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    }));
    const { service } = createResolutionService({ transactions });

    await expect(service.resolveOrMaterializeBillingPlan("growth")).resolves.toEqual({
      kind: "READY",
      plan: winner,
      materialized: false,
    });
    expect(transactions).toHaveBeenCalledTimes(2);
    expect(createPlan).toHaveBeenCalledTimes(1);
  });

  it("reads top-up configuration without broadening catalogue selection", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      usageEvents: [
        { creditsGrantedPerUnit: 100 },
        { creditsGrantedPerUnit: 100 },
        { creditsGrantedPerUnit: 0 },
      ],
    });
    const service = new BillingPlanResolutionService({
      merchantPricingPlan: { findUnique },
    } as unknown as PrismaClient);

    await expect(service.readRecoveryCreditTopUpConfiguration("growth")).resolves.toEqual({
      enabled: true,
      creditsPerPack: 100,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { shopifyPlanHandle: "growth" },
      select: { usageEvents: { orderBy: { position: "asc" }, select: { creditsGrantedPerUnit: true } } },
    });
  });

  it("reads database catalogue events and falls back to provider when the model is unavailable", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      shopifyPlanHandle: "growth",
      usageEvents: [{ position: 2, eventHandle: "meter", adminLabel: "Meter", creditsGrantedPerUnit: 25 }],
    });
    const databaseService = new BillingPlanResolutionService({
      merchantPricingPlan: { findUnique },
    } as unknown as PrismaClient);
    await expect(databaseService.readMerchantPricingPlan("growth")).resolves.toEqual({
      shopifyPlanHandle: "growth",
      usageEvents: [{ cataloguePosition: 2, eventHandle: "meter", adminLabel: "Meter", creditsGrantedPerUnit: 25 }],
    });
    expect(providerRead).not.toHaveBeenCalled();

    providerRead.mockResolvedValue({ shopifyPlanHandle: "growth", usageEvents: [] });
    const fallbackService = new BillingPlanResolutionService({} as PrismaClient);
    await expect(fallbackService.readMerchantPricingPlan("growth")).resolves.toEqual({
      shopifyPlanHandle: "growth",
      usageEvents: [],
    });
    expect(providerRead).toHaveBeenCalledWith({ planHandle: "growth" });
  });
});