import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("@modainteract/moda-interact-shared/merchant-knowledge", () => ({
  MerchantKnowledgeFeatureConfigurationSchema: { safeParse: mocks.parse },
}));

import { loadCurrentMerchantKnowledgeEntitlement } from "../../app/services/merchant-knowledge/merchant-knowledge-entitlement.server";

type TestClient = { subscription: { findUnique: ReturnType<typeof vi.fn> } };

const configuration = { maxKnowledgeSources: 4, allowedSourceTypes: [] };
const validSubscription = {
  status: "ACTIVE",
  planId: "current-plan",
  plan: {
    active: true,
    features: [
      {
        enabled: true,
        configuration,
        feature: {
          key: "merchant_knowledge",
          active: true,
          activationMode: "MERCHANT_OPT_IN",
        },
      },
    ],
  },
};

function clientWith(subscription: unknown) {
  const findUnique = vi.fn().mockResolvedValue(subscription);
  return { client: { subscription: { findUnique } } as TestClient, findUnique };
}

function loadEntitlement(shopId: string, client: TestClient) {
  return loadCurrentMerchantKnowledgeEntitlement(
    shopId,
    client as unknown as NonNullable<Parameters<typeof loadCurrentMerchantKnowledgeEntitlement>[1]>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockReturnValue({ success: true, data: configuration });
});

it("grants configuration access from the current active opt-in mapping only", async () => {
  const { client, findUnique } = clientWith(validSubscription);

  await expect(
    loadEntitlement("shop-1", client),
  ).resolves.toEqual({ kind: "entitled", configuration });
  expect(findUnique).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { shopId: "shop-1" },
      select: expect.objectContaining({ planId: true }),
    }),
  );
  expect(mocks.parse).toHaveBeenCalledWith(configuration);
});

it.each([
  null,
  { ...validSubscription, status: "FROZEN" },
  { ...validSubscription, planId: null },
  { ...validSubscription, plan: { ...validSubscription.plan, active: false } },
  {
    ...validSubscription,
    plan: {
      ...validSubscription.plan,
      features: [
        {
          ...validSubscription.plan.features[0],
          feature: {
            ...validSubscription.plan.features[0].feature,
            activationMode: "ALWAYS_ENABLED",
          },
        },
      ],
    },
  },
])("denies configuration without a current eligible plan mapping", async (subscription) => {
  const { client } = clientWith(subscription);

  await expect(
    loadEntitlement("shop-1", client),
  ).resolves.toEqual({ kind: "denied" });
  expect(mocks.parse).not.toHaveBeenCalled();
});

it("fails closed for malformed Shared C2 configuration", async () => {
  mocks.parse.mockReturnValue({ success: false });
  const { client } = clientWith(validSubscription);

  await expect(
    loadEntitlement("shop-1", client),
  ).resolves.toEqual({ kind: "unavailable", retryable: false });
});

it("reports a database read failure as retryable and unavailable", async () => {
  const { client } = clientWith(null);
  client.subscription.findUnique.mockRejectedValue(new Error("database offline"));

  await expect(
    loadEntitlement("shop-1", client),
  ).resolves.toEqual({ kind: "unavailable", retryable: true });
});