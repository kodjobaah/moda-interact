import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ entitlement: vi.fn() }));

vi.mock("../../app/services/merchant-knowledge/merchant-knowledge-entitlement.server", () => ({
  loadCurrentMerchantKnowledgeEntitlement: mocks.entitlement,
}));
vi.mock("../../app/db.server", () => ({ default: {} }));

import { loadMerchantKnowledge } from "../../app/services/merchant-knowledge/merchant-knowledge.server";

const configuration = {
  maxKnowledgeSources: 1,
  maxContentUnitsPerSource: 1000,
  allowedSourceTypes: [{ purposeKey: "FAQ", dataFormatKey: "WEB_PAGE" }],
};

const pairs = [
  {
    purpose: { key: "FAQ", displayName: "FAQ" },
    dataFormat: { key: "WEB_PAGE", displayName: "Web page" },
  },
  {
    purpose: { key: "FAQ", displayName: "FAQ" },
    dataFormat: { key: "CSV", displayName: "CSV" },
  },
];

function source(id: string, purposeKey: string, dataFormatKey: string, position: number) {
  return {
    id,
    name: id,
    purpose: { key: purposeKey, displayName: purposeKey, active: true },
    dataFormat: { key: dataFormatKey, displayName: dataFormatKey, active: true },
    languageTag: "en",
    position,
    currentGeneration: 1,
    revisions: [{
      id: `${id}-revision`,
      generation: 1,
      reason: "CREATE",
      status: "PENDING",
      requestedUrl: "https://example.test/",
      resolvedUrl: null,
      contentUnits: null,
      truncated: false,
      fetchedAt: null,
      completedAt: null,
      failureCode: null,
      normalizedContent: "must not be returned",
      chunks: [{ embedding: [1, 2, 3] }],
    }],
  };
}

function database(
  sources: ReturnType<typeof source>[],
  preference: { enabled: boolean } | null = { enabled: false },
) {
  return {
    shopSettings: { findUnique: vi.fn().mockResolvedValue({ defaultLanguageTag: "en" }) },
    merchantKnowledgePurposeDataFormat: { findMany: vi.fn().mockResolvedValue(pairs) },
    merchantKnowledgeSource: { findMany: vi.fn().mockResolvedValue(sources) },
    merchantKnowledgeSourceRevision: { findMany: vi.fn().mockResolvedValue([]) },
    feature: { findUnique: vi.fn().mockResolvedValue({ id: "feature-mk", active: true, activationMode: "MERCHANT_OPT_IN" }) },
    shopFeaturePreference: { findUnique: vi.fn().mockResolvedValue(preference) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entitlement.mockResolvedValue({ kind: "entitled", configuration });
});

it("limits the catalogue to supported WEB_PAGE pairs and filters source types before the cap", async () => {
  const client = database([
    source("csv-source", "FAQ", "CSV", 0),
    source("web-source", "FAQ", "WEB_PAGE", 1),
  ]);

  const result = await loadMerchantKnowledge(
    "shop-1",
    client as unknown as NonNullable<Parameters<typeof loadMerchantKnowledge>[1]>,
  );

  expect(client.merchantKnowledgePurposeDataFormat.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        purpose: { active: true },
        dataFormat: { active: true, key: "WEB_PAGE", inputKind: "REMOTE_URL" },
      },
    }),
  );
  expect(result.catalogue.map(({ dataFormat }) => dataFormat.key)).toEqual(["WEB_PAGE"]);
  expect(result).toMatchObject({
    planEntitled: true,
    merchantEnabled: false,
    effectiveEnabled: false,
    configuredCount: 2,
    planEligibleSourceCount: 1,
    sources: [
      { id: "csv-source", currentlyPlanEntitled: false, processingEligible: false, dormantReason: "SOURCE_TYPE" },
      { id: "web-source", currentlyPlanEntitled: true, processingEligible: false, dormantReason: "MERCHANT_DISABLED" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("must not be returned");
  expect(JSON.stringify(result)).not.toContain("embedding");
});

it.each([null, { enabled: false }])(
  "treats a missing or false merchant preference as OFF",
  async (preference) => {
    const client = database([], preference);

    const result = await loadMerchantKnowledge(
      "shop-1",
      client as unknown as NonNullable<Parameters<typeof loadMerchantKnowledge>[1]>,
    );

    expect(result).toMatchObject({
      planEntitled: true,
      merchantEnabled: false,
      effectiveEnabled: false,
    });
  },
);

it("enables processing only when the current opt-in preference is true", async () => {
  const client = database([], { enabled: true });

  const result = await loadMerchantKnowledge(
    "shop-1",
    client as unknown as NonNullable<Parameters<typeof loadMerchantKnowledge>[1]>,
  );

  expect(result).toMatchObject({
    planEntitled: true,
    merchantEnabled: true,
    effectiveEnabled: true,
  });
});