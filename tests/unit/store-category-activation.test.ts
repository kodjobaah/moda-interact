import { createHash } from "node:crypto";
import {
  CommerceAgentPromptScope,
  CommerceEnvironment,
  CommercePromptRevisionStatus,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateInitialPendingStoreCategoryIfEligible,
  resolveShopifyCommerceEnvironment,
} from "../../app/services/store-profile/store-category-activation.server";

const now = new Date("2026-09-30T19:00:00.000Z");
const promptText = "Pinned canonical instructions\nSecond line.";

function makeActivationStore(options: {
  status?: SubscriptionProjectionStatus;
  planId?: string | null;
  profile?: Record<string, unknown> | null;
  revision?: Record<string, unknown> | null;
  category?: Record<string, unknown> | null;
  configurations?: Array<Record<string, unknown>>;
} = {}) {
  const state = {
    subscription: {
      status: options.status ?? SubscriptionProjectionStatus.ACTIVE,
      planId: options.planId === undefined ? "plan-1" : options.planId,
    },
    profile: options.profile === undefined
      ? {
          activeCategoryId: null,
          pendingCategoryId: "category-1",
          pendingPromptRevisionId: "revision-1",
          pendingSelectionGeneration: 3,
          pendingSelectedAt: new Date("2026-09-29T12:00:00.000Z"),
        }
      : options.profile,
    category: options.category === undefined
      ? { id: "category-1", defaultTemplateId: "template-1" }
      : options.category,
    revision: options.revision === undefined
      ? {
          id: "revision-1",
          promptId: "prompt-1",
          status: CommercePromptRevisionStatus.DRAFT,
          promptText,
          sourceTemplateId: "template-1",
          sourceTemplateEditVersion: 7,
          prompt: { scope: CommerceAgentPromptScope.SHOP, shopId: "shop-1" },
        }
      : options.revision,
    configurations: options.configurations ?? [],
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    subscription: {
      findUnique: vi.fn(async () => state.subscription),
    },
    commerceShopProfile: {
      findUnique: vi.fn(async () => state.profile),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!state.profile) return { count: 0 };
        Object.assign(state.profile, data);
        return { count: 1 };
      }),
    },
    commercePromptTemplateCategory: {
      findUnique: vi.fn(async () => state.category),
    },
    commerceAgentPromptRevision: {
      findUnique: vi.fn(async () => state.revision),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (!state.revision) return { count: 0 };
        Object.assign(state.revision, data);
        return { count: 1 };
      }),
    },
    commerceAgentConfiguration: {
      findMany: vi.fn(async () => state.configurations),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.configurations[0], {
          activePromptRevisionId: data.activePromptRevisionId,
          promptEditVersion: (state.configurations[0]?.promptEditVersion as number) + 1,
        });
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.configurations.push({ ...data, modelId: null, modelEditVersion: 1 });
      }),
    },
  };
  const client = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  return { client, tx, state };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Shopify Commerce environment", () => {
  it.each([
    ["local", CommerceEnvironment.LOCAL],
    ["test", CommerceEnvironment.TEST],
    ["development", CommerceEnvironment.DEVELOPMENT],
    ["staging", CommerceEnvironment.STAGING],
    ["production", CommerceEnvironment.PRODUCTION],
  ])("maps %s exactly", (value, environment) => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", value);
    expect(resolveShopifyCommerceEnvironment()).toBe(environment);
  });

  it("rejects an unknown deployment environment", () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "preview");
    expect(() => resolveShopifyCommerceEnvironment()).toThrow(
      "Commerce environment is unavailable.",
    );
  });
});

describe("initial pending Store Category activation", () => {
  beforeEach(() => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
  });

  it.each([
    SubscriptionProjectionStatus.ACTIVE,
    SubscriptionProjectionStatus.TRIALING,
  ])("publishes the exact pinned DRAFT under %s", async (status) => {
    const existingConfiguration = {
      id: "configuration-1",
      modelId: "model-1",
      modelEditVersion: 8,
      promptEditVersion: 4,
    };
    const { client, tx, state } = makeActivationStore({
      status,
      configurations: [existingConfiguration],
    });

    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: "shop-1", expectedPendingSelectionGeneration: 3 },
      client as never,
      now,
    )).resolves.toEqual({
      kind: "ACTIVATED",
      categoryId: "category-1",
      promptRevisionId: "revision-1",
    });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.commerceAgentPromptRevision.updateMany).toHaveBeenCalledWith({
      where: {
        id: "revision-1",
        promptId: "prompt-1",
        status: CommercePromptRevisionStatus.DRAFT,
      },
      data: {
        status: CommercePromptRevisionStatus.PUBLISHED,
        contentHash: createHash("sha256").update(promptText, "utf8").digest("hex"),
        publishedAt: now,
      },
    });
    expect(state.revision).toMatchObject({
      promptText,
      sourceTemplateId: "template-1",
      status: CommercePromptRevisionStatus.PUBLISHED,
    });
    expect(tx.commercePromptTemplateCategory.findUnique).toHaveBeenCalledOnce();
    expect(state.configurations[0]).toMatchObject({
      activePromptRevisionId: "revision-1",
      modelId: "model-1",
      modelEditVersion: 8,
      promptEditVersion: 5,
    });
    expect(state.profile).toMatchObject({
      activeCategoryId: "category-1",
      activeCategoryActivatedAt: now,
      pendingCategoryId: null,
      pendingPromptRevisionId: null,
      pendingSelectedAt: null,
      pendingSelectionGeneration: 3,
    });
    expect(Object.keys(state)).not.toContain("merchantKnowledge");
  });

  it("creates a SHOP configuration without a model when none exists", async () => {
    const { client, tx, state } = makeActivationStore();
    await activateInitialPendingStoreCategoryIfEligible({ shopId: "shop-1" }, client as never, now);

    expect(tx.commerceAgentConfiguration.create).toHaveBeenCalledWith({
      data: {
        environment: CommerceEnvironment.TEST,
        scope: CommerceAgentPromptScope.SHOP,
        shopId: "shop-1",
        activePromptRevisionId: "revision-1",
        promptEditVersion: 2,
      },
    });
    expect(state.configurations[0]).toMatchObject({
      modelId: null,
      modelEditVersion: 1,
      promptEditVersion: 2,
    });
  });

  it("returns ALREADY_ACTIVE on replay without republishing or incrementing configuration again", async () => {
    const { client, tx, state } = makeActivationStore();
    await activateInitialPendingStoreCategoryIfEligible({ shopId: "shop-1" }, client as never, now);
    const activatedRevision = { ...state.revision };
    const activatedConfiguration = { ...state.configurations[0] };

    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: "shop-1" }, client as never, new Date("2026-10-01T00:00:00.000Z"),
    )).resolves.toEqual({ kind: "ALREADY_ACTIVE" });

    expect(state.revision).toEqual(activatedRevision);
    expect(state.configurations[0]).toEqual(activatedConfiguration);
    expect(tx.commerceAgentPromptRevision.updateMany).toHaveBeenCalledOnce();
    expect(tx.commerceAgentConfiguration.create).toHaveBeenCalledOnce();
  });

  it("does not activate without an active subscription and current plan", async () => {
    for (const options of [
      { status: SubscriptionProjectionStatus.NO_CONTRACT, planId: null },
      { status: SubscriptionProjectionStatus.ACTIVE, planId: null },
    ] as const) {
      const { client, tx } = makeActivationStore(options);
      await expect(activateInitialPendingStoreCategoryIfEligible(
        { shopId: "shop-1" },
        client as never,
        now,
      )).resolves.toEqual({ kind: "SUBSCRIPTION_NOT_ACTIVE" });
      expect(tx.commerceShopProfile.findUnique).not.toHaveBeenCalled();
      expect(tx.commerceAgentPromptRevision.updateMany).not.toHaveBeenCalled();
    }
  });

  it("returns NO_PENDING when the profile or pending state is absent", async () => {
    const noProfile = makeActivationStore({ profile: null });
    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: "shop-1" }, noProfile.client as never, now,
    )).resolves.toEqual({ kind: "NO_PENDING" });

    const noPending = makeActivationStore({ profile: {
      activeCategoryId: null,
      pendingCategoryId: null,
      pendingPromptRevisionId: null,
      pendingSelectionGeneration: 0,
      pendingSelectedAt: null,
    } });
    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: "shop-1" }, noPending.client as never, now,
    )).resolves.toEqual({ kind: "NO_PENDING" });
  });

  it("preserves later pending category state when an active category already exists", async () => {
    const profile = {
      activeCategoryId: "category-old",
      pendingCategoryId: "category-later",
      pendingPromptRevisionId: "revision-later",
      pendingSelectionGeneration: 9,
      pendingSelectedAt: now,
    };
    const { client, tx, state } = makeActivationStore({ profile });

    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: "shop-1" }, client as never, now,
    )).resolves.toEqual({ kind: "ALREADY_ACTIVE" });
    expect(state.profile).toEqual(profile);
    expect(tx.commerceAgentPromptRevision.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed on stale generations and inconsistent pending provenance", async () => {
    const stale = makeActivationStore();
    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: "shop-1", expectedPendingSelectionGeneration: 2 },
      stale.client as never,
      now,
    )).rejects.toMatchObject({ code: "STORE_CATEGORY_PENDING_STATE_CONFLICT" });

    const wrongTemplate = makeActivationStore({
      revision: {
        id: "revision-1",
        promptId: "prompt-1",
        status: CommercePromptRevisionStatus.DRAFT,
        promptText,
        sourceTemplateId: "template-old",
        sourceTemplateEditVersion: 7,
        prompt: { scope: CommerceAgentPromptScope.SHOP, shopId: "shop-1" },
      },
    });
    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: "shop-1" }, wrongTemplate.client as never, now,
    )).rejects.toMatchObject({ code: "STORE_CATEGORY_PENDING_STATE_CONFLICT" });
  });

  it("rejects duplicate configurations rather than selecting an arbitrary one", async () => {
    const { client, tx } = makeActivationStore({ configurations: [{ id: "a" }, { id: "b" }] });
    await expect(activateInitialPendingStoreCategoryIfEligible(
      { shopId: "shop-1" }, client as never, now,
    )).rejects.toMatchObject({ code: "STORE_CATEGORY_PENDING_STATE_CONFLICT" });
    expect(tx.commerceAgentPromptRevision.updateMany).not.toHaveBeenCalled();
  });
});