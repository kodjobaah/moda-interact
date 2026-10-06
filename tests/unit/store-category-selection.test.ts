import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { listSelectableStoreCategories, loadStoreProfile } from "../../app/services/store-profile/store-category.server";
import { selectPendingStoreCategory } from "../../app/services/store-profile/store-category-selection.server";

type ProfileState = {
  shopId: string;
  activeCategoryId?: string | null;
  activeCategoryActivatedAt?: Date | null;
  pendingCategoryId?: string | null;
  pendingPromptRevisionId?: string | null;
  pendingSelectionGeneration: number;
  pendingSelectedAt?: Date | null;
};
type DraftState = {
  id: string;
  promptId: string;
  revisionNumber: number;
  status: string;
  editVersion: number;
  [key: string]: unknown;
};
type MakeStoreOptions = {
  profile?: ProfileState | null;
  lineages?: Array<{ id: string }>;
  existingDraft?: DraftState | null;
  latestRevisionNumber?: number;
  configurations?: Array<Record<string, unknown>>;
};

const makeStore = ({
  profile = null,
  lineages = [],
  existingDraft = null,
  latestRevisionNumber = 0,
  configurations = [],
}: MakeStoreOptions = {}) => {
  const state = {
    profile: profile ? { ...profile } : null,
    lineages: [...lineages],
    draft: existingDraft ? { ...existingDraft } : null,
    latestRevisionNumber,
    configurations: configurations.map((configuration) => ({ ...configuration })),
    category: {
      id: "category-home",
      slug: "home-goods",
      editVersion: 4,
      enabled: true,
      defaultTemplateId: "template-home",
      defaultTemplate: {
        id: "template-home",
        key: "home-goods.default",
        displayName: "Home goods",
        editVersion: 7,
        enabled: true,
        categoryId: "category-home",
        promptText: "Canonical English prompt\nSecond line.",
      },
      taxonomyMappings: [
        { id: "mapping-shoes", categoryId: "category-home", editVersion: 2, conditionKey: "shoes", weight: 2 },
        { id: "mapping-handbags", categoryId: "category-home", editVersion: 3, conditionKey: "handbags", weight: 1 },
      ],
    },
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    commerceShopProfile: {
      findUnique: vi.fn(async () => state.profile),
      create: vi.fn(async ({ data }) => {
        state.profile = {
          shopId: data.shopId,
          activeCategoryId: null,
          activeCategoryActivatedAt: null,
          pendingCategoryId: null,
          pendingPromptRevisionId: null,
          pendingSelectedAt: null,
          pendingSelectionGeneration: 0,
        };
        return state.profile;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          !state.profile ||
          state.profile.pendingSelectionGeneration !== where.pendingSelectionGeneration ||
          (Object.prototype.hasOwnProperty.call(where, "activeCategoryId") &&
            state.profile.activeCategoryId !== where.activeCategoryId)
        ) return { count: 0 };

        const nextGeneration = data.pendingSelectionGeneration?.increment
          ? state.profile.pendingSelectionGeneration + data.pendingSelectionGeneration.increment
          : state.profile.pendingSelectionGeneration;
        Object.assign(state.profile, {
          ...(Object.prototype.hasOwnProperty.call(data, "activeCategoryId")
            ? { activeCategoryId: data.activeCategoryId }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(data, "activeCategoryActivatedAt")
            ? { activeCategoryActivatedAt: data.activeCategoryActivatedAt }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(data, "pendingCategoryId")
            ? { pendingCategoryId: data.pendingCategoryId }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(data, "pendingPromptRevisionId")
            ? { pendingPromptRevisionId: data.pendingPromptRevisionId }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(data, "pendingSelectedAt")
            ? { pendingSelectedAt: data.pendingSelectedAt }
            : {}),
          pendingSelectionGeneration: nextGeneration,
        });
        return { count: 1 };
      }),
    },
    commercePromptTemplateCategory: {
      findUnique: vi.fn(async () => state.category),
    },
    commerceAgentPrompt: {
      findMany: vi.fn(async () => state.lineages),
      create: vi.fn(async () => {
        const lineage = { id: "shop-prompt" };
        state.lineages.push(lineage);
        return lineage;
      }),
    },
    commerceAgentPromptRevision: {
      findUnique: vi.fn(async () => state.draft
        ? { ...state.draft, prompt: { scope: "SHOP", shopId: "shop-1" } }
        : null),
      findFirst: vi.fn(async ({ where }) =>
        where.status ? state.draft : { revisionNumber: state.latestRevisionNumber },
      ),
      create: vi.fn(async ({ data }) => {
        const draft = { id: "draft-1", ...data, editVersion: 1 };
        state.draft = draft;
        return { id: draft.id, revisionNumber: draft.revisionNumber };
      }),
      update: vi.fn(async ({ where, data }) => {
        const draft = state.draft;
        if (!draft) throw new Error("Expected pending DRAFT");
        Object.assign(draft, {
          ...(Object.prototype.hasOwnProperty.call(data, "status") ? { status: data.status } : {}),
          promptText: data.promptText,
          sourceTemplateId: data.sourceTemplateId,
          sourceTemplateEditVersion: data.sourceTemplateEditVersion,
          sourceContext: data.sourceContext,
          ...(Object.prototype.hasOwnProperty.call(data, "contentHash") ? { contentHash: data.contentHash } : {}),
          ...(Object.prototype.hasOwnProperty.call(data, "publishedAt") ? { publishedAt: data.publishedAt } : {}),
          editVersion: data.editVersion?.increment ? draft.editVersion + data.editVersion.increment : draft.editVersion,
        });
        return { id: where.id, revisionNumber: draft.revisionNumber };
      }),
      updateMany: vi.fn(async ({ data }) => {
        if (!state.draft) return { count: 0 };
        Object.assign(state.draft, data);
        return { count: 1 };
      }),
    },
    commerceAgentConfiguration: {
      findMany: vi.fn(async () => state.configurations),
      update: vi.fn(async ({ data }) => {
        if (!state.configurations[0]) throw new Error("Expected configuration");
        Object.assign(state.configurations[0], {
          activePromptRevisionId: data.activePromptRevisionId,
          promptEditVersion: Number(state.configurations[0].promptEditVersion ?? 1) + 1,
        });
      }),
      create: vi.fn(async ({ data }) => {
        state.configurations.push({ id: "configuration-1", ...data });
      }),
    },
  };
  const client = {
    commerceShopProfile: tx.commerceShopProfile,
    commercePromptTemplateCategory: tx.commercePromptTemplateCategory,
    $transaction: vi.fn(async (callback) => callback(tx)),
  };
  return { client, tx, state };
};

const select = (
  client: unknown,
  generation = 0,
  now = new Date("2026-09-30T12:00:00.000Z"),
  selectedMappingIds: string[] = [],
) =>
  selectPendingStoreCategory({
    shopId: "shop-1",
    categoryId: "category-home",
    expectedPendingSelectionGeneration: generation,
    selectedMappingIds,
  }, client as never, now);

describe("pending Store Category selection", () => {
  it("accepts an enabled Admin-authored category even when no Shopify localization keys exist", async () => {
    const { client, state } = makeStore({ latestRevisionNumber: 1 });
    state.category.slug = "not-localized";

    await expect(select(client)).resolves.toMatchObject({
      pendingCategoryId: "category-home",
      pendingPromptRevisionId: "draft-1",
      pendingSelectionGeneration: 1,
    });
  });

  it("creates one Shop lineage and pins the exact canonical-English template as a DRAFT", async () => {
    const { client, tx, state } = makeStore({ latestRevisionNumber: 3 });

    await expect(select(client)).resolves.toEqual({
      pendingCategoryId: "category-home",
      pendingPromptRevisionId: "draft-1",
      pendingSelectionGeneration: 1,
    });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.commerceAgentPrompt.create).toHaveBeenCalledOnce();
    expect(tx.commerceAgentPromptRevision.create).toHaveBeenCalledWith({
      data: {
        promptId: "shop-prompt",
        revisionNumber: 4,
        status: "DRAFT",
        promptText: "Canonical English prompt\nSecond line.",
        sourceTemplateId: "template-home",
        sourceTemplateEditVersion: 7,
        sourceContext: {
          schemaVersion: 1,
          kind: "STORE_CATEGORY_SELECTION",
          categoryId: "category-home",
          categoryEditVersion: 4,
          templateId: "template-home",
          templateEditVersion: 7,
          mappings: [],
        },
      },
      select: { id: true, revisionNumber: true },
    });
    expect(state.profile).toMatchObject({
      pendingCategoryId: "category-home",
      pendingPromptRevisionId: "draft-1",
      pendingSelectedAt: new Date("2026-09-30T12:00:00.000Z"),
      pendingSelectionGeneration: 1,
      activeCategoryId: null,
      activeCategoryActivatedAt: null,
    });
    expect(tx.commerceAgentConfiguration.update).not.toHaveBeenCalled();
  });

  it("publishes an already-active shop category change immediately from the Admin-authored template", async () => {
    const activatedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-09-30T12:00:00.000Z");
    const { client, tx, state } = makeStore({
      profile: {
        shopId: "shop-1",
        activeCategoryId: "active-category",
        activeCategoryActivatedAt: activatedAt,
        pendingCategoryId: "category-home",
        pendingPromptRevisionId: "draft-1",
        pendingSelectionGeneration: 4,
      },
      lineages: [{ id: "shop-prompt" }],
      existingDraft: {
        id: "draft-1",
        promptId: "shop-prompt",
        revisionNumber: 8,
        status: "DRAFT",
        editVersion: 2,
        promptText: "Old prompt",
        sourceTemplateId: "template-home",
        sourceTemplateEditVersion: 7,
      },
      configurations: [{
        id: "configuration-1",
        activePromptRevisionId: "revision-old",
        promptEditVersion: 4,
      }],
    });
    state.category.defaultTemplate.promptText = "Updated canonical prompt";
    state.category.defaultTemplate.editVersion = 8;

    await expect(select(client, 4, now)).resolves.toEqual({
      activeCategoryId: "category-home",
      activePromptRevisionId: "draft-1",
      pendingCategoryId: null,
      pendingPromptRevisionId: null,
      pendingSelectionGeneration: 5,
    });

    expect(tx.commerceAgentPrompt.create).not.toHaveBeenCalled();
    expect(tx.commerceAgentPromptRevision.create).not.toHaveBeenCalled();
    expect(tx.commerceAgentPromptRevision.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: {
        status: "PUBLISHED",
        promptText: "Updated canonical prompt",
        sourceTemplateId: "template-home",
        sourceTemplateEditVersion: 8,
        sourceContext: {
          schemaVersion: 1,
          kind: "STORE_CATEGORY_SELECTION",
          categoryId: "category-home",
          categoryEditVersion: 4,
          templateId: "template-home",
          templateEditVersion: 8,
          mappings: [],
        },
        contentHash: createHash("sha256").update("Updated canonical prompt", "utf8").digest("hex"),
        publishedAt: now,
        editVersion: { increment: 1 },
      },
      select: { id: true, revisionNumber: true },
    });
    expect(state.draft).toMatchObject({
      status: "PUBLISHED",
      editVersion: 3,
      promptText: "Updated canonical prompt",
      publishedAt: now,
    });
    expect(state.configurations[0]).toMatchObject({
      activePromptRevisionId: "draft-1",
      promptEditVersion: 5,
    });
    expect(state.profile).toMatchObject({
      activeCategoryId: "category-home",
      activeCategoryActivatedAt: now,
      pendingCategoryId: null,
      pendingPromptRevisionId: null,
      pendingSelectedAt: null,
      pendingSelectionGeneration: 5,
    });
  });

  it("publishes mapping-only changes immediately for an active category", async () => {
    const now = new Date("2026-09-30T13:00:00.000Z");
    const { client, tx, state } = makeStore({
      profile: {
        shopId: "shop-1",
        activeCategoryId: "category-home",
        activeCategoryActivatedAt: new Date("2026-01-01T00:00:00.000Z"),
        pendingCategoryId: null,
        pendingPromptRevisionId: null,
        pendingSelectedAt: null,
        pendingSelectionGeneration: 2,
      },
      lineages: [{ id: "shop-prompt" }],
      latestRevisionNumber: 5,
      configurations: [{
        id: "configuration-1",
        activePromptRevisionId: "revision-old",
        promptEditVersion: 7,
      }],
    });
    state.category.defaultTemplate.promptText = [
      "Base prompt.",
      "{% if mappings.shoes %}Footwear guidance.{% endif %}",
    ].join("\n");

    await expect(select(client, 2, now, ["mapping-shoes"])).resolves.toEqual({
      activeCategoryId: "category-home",
      activePromptRevisionId: "draft-1",
      pendingCategoryId: null,
      pendingPromptRevisionId: null,
      pendingSelectionGeneration: 3,
    });

    expect(tx.commerceAgentPromptRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        revisionNumber: 6,
        status: "PUBLISHED",
        promptText: "Base prompt.\nFootwear guidance.",
        publishedAt: now,
        sourceContext: {
          schemaVersion: 1,
          kind: "STORE_CATEGORY_SELECTION",
          categoryId: "category-home",
          categoryEditVersion: 4,
          templateId: "template-home",
          templateEditVersion: 7,
          mappings: [{
            mappingId: "mapping-shoes",
            mappingEditVersion: 2,
            conditionKey: "shoes",
          }],
        },
      }),
      select: { id: true, revisionNumber: true },
    });
    expect(state.draft).toMatchObject({
      status: "PUBLISHED",
      promptText: "Base prompt.\nFootwear guidance.",
    });
    expect(state.profile).toMatchObject({
      activeCategoryId: "category-home",
      activeCategoryActivatedAt: now,
      pendingCategoryId: null,
      pendingPromptRevisionId: null,
      pendingSelectedAt: null,
      pendingSelectionGeneration: 3,
    });
    expect(state.configurations[0]).toMatchObject({
      activePromptRevisionId: "draft-1",
      promptEditVersion: 8,
    });
  });

  it("renders selected mapping conditions and stores immutable mapping provenance", async () => {
    const { client, tx, state } = makeStore({ latestRevisionNumber: 1 });
    state.category.defaultTemplate.promptText = [
      "Base prompt.",
      "{% if mappings.shoes %}Footwear guidance.{% endif %}",
      "{% if mappings.handbags %}Handbag guidance.{% endif %}",
    ].join("\n");

    await expect(select(
      client,
      0,
      new Date("2026-09-30T12:00:00.000Z"),
      ["mapping-shoes"],
    )).resolves.toMatchObject({ pendingPromptRevisionId: "draft-1" });

    expect(tx.commerceAgentPromptRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        promptText: "Base prompt.\nFootwear guidance.\n",
        sourceContext: {
          schemaVersion: 1,
          kind: "STORE_CATEGORY_SELECTION",
          categoryId: "category-home",
          categoryEditVersion: 4,
          templateId: "template-home",
          templateEditVersion: 7,
          mappings: [{
            mappingId: "mapping-shoes",
            mappingEditVersion: 2,
            conditionKey: "shoes",
          }],
        },
      }),
      select: { id: true, revisionNumber: true },
    });
  });

  it("rejects mapping selections that do not belong to the selected category contract", async () => {
    const { client, tx } = makeStore();

    await expect(select(
      client,
      0,
      new Date("2026-09-30T12:00:00.000Z"),
      ["mapping-foreign"],
    )).rejects.toMatchObject({ code: "CATEGORY_UNAVAILABLE" });

    expect(tx.commerceAgentPromptRevision.create).not.toHaveBeenCalled();
  });

  it("rejects a stale generation before reading or writing the category", async () => {
    const { client, tx } = makeStore({
      profile: { shopId: "shop-1", pendingSelectionGeneration: 2 },
    });

    await expect(select(client, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.commercePromptTemplateCategory.findUnique).not.toHaveBeenCalled();
    expect(tx.commerceAgentPromptRevision.create).not.toHaveBeenCalled();
  });

  it("fails closed when Admin changes the prepared category contract before the CAS transaction", async () => {
    const { client, tx, state } = makeStore({
      profile: { shopId: "shop-1", pendingSelectionGeneration: 0 },
    });
    client.$transaction = vi.fn(async (callback) => {
      state.category.editVersion += 1;
      return callback(tx);
    });

    await expect(select(client)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.commerceAgentPromptRevision.create).not.toHaveBeenCalled();
    expect(tx.commerceShopProfile.updateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite an unrelated DRAFT when the profile has no pending pointer", async () => {
    const { client, tx } = makeStore({
      lineages: [{ id: "shop-prompt" }],
      existingDraft: {
        id: "unrelated-draft",
        promptId: "shop-prompt",
        revisionNumber: 5,
        status: "DRAFT",
        editVersion: 1,
      },
    });

    await expect(select(client)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.commerceAgentPromptRevision.update).not.toHaveBeenCalled();
    expect(tx.commerceAgentPromptRevision.create).not.toHaveBeenCalled();
  });
});


describe("Store Category profile mapping provenance", () => {
  it("restores pending and active mapping selections from prompt revision sourceContext", async () => {
    const category = {
      id: "category-home",
      slug: "home-goods",
      displayName: "Home goods",
      description: "Home products",
      translations: [],
    };
    const sourceContext = {
      schemaVersion: 1,
      kind: "STORE_CATEGORY_SELECTION",
      categoryId: "category-home",
      categoryEditVersion: 4,
      templateId: "template-home",
      templateEditVersion: 7,
      mappings: [{ mappingId: "mapping-shoes", mappingEditVersion: 2, conditionKey: "shoes" }],
    };
    const client = {
      commerceShopProfile: {
        findUnique: vi.fn(async () => ({
          shopId: "shop-1",
          activeCategoryId: "category-home",
          pendingCategoryId: "category-home",
          pendingPromptRevisionId: "draft-1",
          pendingSelectionGeneration: 3,
          activeCategory: category,
          pendingCategory: category,
          pendingPromptRevision: {
            sourceContext,
            sourceTemplateEditVersion: 7,
            sourceTemplate: { id: "template-home", key: "home.default", displayName: "Home", editVersion: 7 },
          },
        })),
      },
      commerceAgentConfiguration: {
        findMany: vi.fn(async () => [{ activePromptRevision: { sourceContext } }]),
      },
      commercePromptTemplateCategory: { findMany: vi.fn() },
    } as never;

    await expect(loadStoreProfile("shop-1", "en", client)).resolves.toMatchObject({
      activeMappingIds: ["mapping-shoes"],
      pendingMappingIds: ["mapping-shoes"],
    });
  });
});

describe("selectable Store Category read model", () => {
  it("reads merchant-facing category and mapping localization from PostgreSQL with English fallback", async () => {
    const template = {
      id: "template-home",
      key: "home-goods.default",
      displayName: "Home goods",
      editVersion: 7,
      enabled: true,
      categoryId: "category-home",
      promptText: "Do not expose this prompt.",
    };
    const rows = [
      {
        id: "late",
        slug: "late",
        displayName: "Late canonical",
        description: "Late canonical description",
        enabled: true,
        displayOrder: 5,
        defaultTemplateId: "late-template",
        defaultTemplate: { ...template, id: "late-template", categoryId: "late" },
        translations: [{ locale: "en", displayName: "Late English", description: "Late English description" }],
        taxonomyMappings: [],
      },
      {
        id: "untranslated",
        slug: "not-localized",
        displayName: "Canonical fallback",
        description: "Canonical fallback description",
        enabled: true,
        displayOrder: 0,
        defaultTemplateId: "unknown-template",
        defaultTemplate: { ...template, id: "unknown-template", categoryId: "untranslated" },
        translations: [],
        taxonomyMappings: [],
      },
      { id: "disabled", slug: "disabled", displayName: "Disabled", description: "Disabled", enabled: false, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: template, translations: [], taxonomyMappings: [] },
      { id: "missing-template", slug: "missing", displayName: "Missing", description: "Missing", enabled: true, displayOrder: 1, defaultTemplateId: null, defaultTemplate: null, translations: [], taxonomyMappings: [] },
      { id: "wrong-category", slug: "wrong", displayName: "Wrong", description: "Wrong", enabled: true, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: { ...template, categoryId: "other" }, translations: [], taxonomyMappings: [] },
      { id: "disabled-template", slug: "disabled-template", displayName: "Disabled template", description: "Disabled template", enabled: true, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: { ...template, enabled: false }, translations: [], taxonomyMappings: [] },
      { id: "blank-template", slug: "blank", displayName: "Blank", description: "Blank", enabled: true, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: { ...template, promptText: "  \n" }, translations: [], taxonomyMappings: [] },
      {
        id: "b",
        slug: "b",
        displayName: "B canonical",
        description: "B canonical description",
        enabled: true,
        displayOrder: 1,
        defaultTemplateId: template.id,
        defaultTemplate: { ...template, id: "template-b", categoryId: "b" },
        translations: [{ locale: "en", displayName: "B English", description: "B English description" }],
        taxonomyMappings: [],
      },
      {
        id: "a",
        slug: "a",
        displayName: "A canonical",
        description: "A canonical description",
        enabled: true,
        displayOrder: 1,
        defaultTemplateId: template.id,
        defaultTemplate: { ...template, id: "template-a", categoryId: "a" },
        translations: [
          { locale: "en", displayName: "Apparel", description: "English apparel description" },
          { locale: "de", displayName: "Bekleidung", description: "Deutsche Beschreibung" },
        ],
        taxonomyMappings: [
          {
            id: "mapping-shoes",
            conditionKey: "shoes",
            displayName: "Footwear",
            taxonomyCategoryName: "Shoes",
            weight: 2,
            translations: [
              { locale: "en", displayName: "Footwear" },
              { locale: "de", displayName: "Schuhe" },
            ],
          },
          {
            id: "mapping-unconfigured",
            conditionKey: null,
            displayName: "Ignored mapping",
            taxonomyCategoryName: "Ignored",
            weight: 1,
            translations: [],
          },
        ],
      },
    ];
    const findMany = vi.fn(async () => rows
      .filter((category) => category.enabled && category.defaultTemplateId !== null)
      .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id)));
    const client = { commercePromptTemplateCategory: { findMany } } as never;

    await expect(listSelectableStoreCategories("de-DE", client)).resolves.toEqual([
      {
        id: "untranslated",
        slug: "not-localized",
        localizedDisplayName: "Canonical fallback",
        localizedDescription: "Canonical fallback description",
        mappings: [],
        defaultTemplate: {
          id: "unknown-template",
          key: "home-goods.default",
          displayName: "Home goods",
          editVersion: 7,
        },
      },
      {
        id: "a",
        slug: "a",
        localizedDisplayName: "Bekleidung",
        localizedDescription: "Deutsche Beschreibung",
        mappings: [
          {
            id: "mapping-shoes",
            conditionKey: "shoes",
            localizedDisplayName: "Schuhe",
          },
        ],
        defaultTemplate: {
          id: "template-a",
          key: "home-goods.default",
          displayName: "Home goods",
          editVersion: 7,
        },
      },
      {
        id: "b",
        slug: "b",
        localizedDisplayName: "B English",
        localizedDescription: "B English description",
        mappings: [],
        defaultTemplate: {
          id: "template-b",
          key: "home-goods.default",
          displayName: "Home goods",
          editVersion: 7,
        },
      },
      {
        id: "late",
        slug: "late",
        localizedDisplayName: "Late English",
        localizedDescription: "Late English description",
        mappings: [],
        defaultTemplate: {
          id: "late-template",
          key: "home-goods.default",
          displayName: "Home goods",
          editVersion: 7,
        },
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        translations: { where: { locale: { in: ["de", "en"] } } },
        taxonomyMappings: expect.objectContaining({
          where: { conditionKey: { not: null } },
        }),
      }),
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    }));
    expect(JSON.stringify(await listSelectableStoreCategories("de-DE", client))).not.toContain("Do not expose this prompt.");
  });
});
