import { describe, expect, it, vi } from "vitest";
import { listSelectableStoreCategories } from "../../app/services/store-profile/store-category.server";
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
};

const makeStore = ({ profile = null, lineages = [], existingDraft = null, latestRevisionNumber = 0 }: MakeStoreOptions = {}) => {
  const state = {
    profile: profile ? { ...profile } : null,
    lineages: [...lineages],
    draft: existingDraft ? { ...existingDraft } : null,
    latestRevisionNumber,
    category: {
      id: "category-home",
      slug: "home-goods",
      enabled: true,
      defaultTemplate: {
        id: "template-home",
        key: "home-goods.default",
        displayName: "Home goods",
        editVersion: 7,
        enabled: true,
        categoryId: "category-home",
        promptText: "Canonical English prompt\nSecond line.",
      },
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
        if (!state.profile || state.profile.pendingSelectionGeneration !== where.pendingSelectionGeneration)
          return { count: 0 };
        Object.assign(state.profile, {
          pendingCategoryId: data.pendingCategoryId,
          pendingPromptRevisionId: data.pendingPromptRevisionId,
          pendingSelectedAt: data.pendingSelectedAt,
          pendingSelectionGeneration: state.profile.pendingSelectionGeneration + 1,
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
      findUnique: vi.fn(async () => state.draft),
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
          promptText: data.promptText,
          sourceTemplateId: data.sourceTemplateId,
          sourceTemplateEditVersion: data.sourceTemplateEditVersion,
          editVersion: draft.editVersion + 1,
        });
        return { id: where.id, revisionNumber: draft.revisionNumber };
      }),
    },
    commerceAgentConfiguration: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const client = { $transaction: vi.fn(async (callback) => callback(tx)) };
  return { client, tx, state };
};

const select = (client: unknown, generation = 0, now = new Date("2026-09-30T12:00:00.000Z")) =>
  selectPendingStoreCategory({
    shopId: "shop-1",
    categoryId: "category-home",
    expectedPendingSelectionGeneration: generation,
  }, client as never, now);

describe("pending Store Category selection", () => {
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
    expect(tx.commerceAgentConfiguration.updateMany).not.toHaveBeenCalled();
  });

  it("repins the same pending DRAFT on repeat selection and increments its edit version", async () => {
    const { client, tx, state } = makeStore({
      profile: {
        shopId: "shop-1",
        activeCategoryId: "active-category",
        activeCategoryActivatedAt: new Date("2026-01-01T00:00:00.000Z"),
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
      },
    });
    state.category.defaultTemplate.promptText = "Updated canonical prompt";
    state.category.defaultTemplate.editVersion = 8;

    await expect(select(client, 4)).resolves.toMatchObject({
      pendingPromptRevisionId: "draft-1",
      pendingSelectionGeneration: 5,
    });

    expect(tx.commerceAgentPrompt.create).not.toHaveBeenCalled();
    expect(tx.commerceAgentPromptRevision.create).not.toHaveBeenCalled();
    expect(tx.commerceAgentPromptRevision.update).toHaveBeenCalledWith({
      where: { id: "draft-1" },
      data: {
        promptText: "Updated canonical prompt",
        sourceTemplateId: "template-home",
        sourceTemplateEditVersion: 8,
        editVersion: { increment: 1 },
      },
      select: { id: true, revisionNumber: true },
    });
    expect(state.draft?.editVersion).toBe(3);
    expect(state.profile).toMatchObject({
      activeCategoryId: "active-category",
      activeCategoryActivatedAt: new Date("2026-01-01T00:00:00.000Z"),
      pendingSelectionGeneration: 5,
    });
  });

  it("rejects a stale generation before reading or writing the category", async () => {
    const { client, tx } = makeStore({
      profile: { shopId: "shop-1", pendingSelectionGeneration: 2 },
    });

    await expect(select(client, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.commercePromptTemplateCategory.findUnique).not.toHaveBeenCalled();
    expect(tx.commerceAgentPromptRevision.create).not.toHaveBeenCalled();
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

describe("selectable Store Category read model", () => {
  it("filters invalid defaults and untranslated slugs, then returns only the ordered browser DTO", async () => {
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
      { id: "late", slug: "home-goods", displayName: "Late", description: "Late", enabled: true, displayOrder: 5, defaultTemplateId: "late-template", defaultTemplate: { ...template, id: "late-template", categoryId: "late" } },
      { id: "untranslated", slug: "not-localized", displayName: "Unknown", description: "Unknown", enabled: true, displayOrder: 0, defaultTemplateId: "unknown-template", defaultTemplate: { ...template, id: "unknown-template", categoryId: "untranslated" } },
      { id: "disabled", slug: "home-goods", displayName: "Disabled", description: "Disabled", enabled: false, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: template },
      { id: "missing-template", slug: "home-goods", displayName: "Missing", description: "Missing", enabled: true, displayOrder: 1, defaultTemplateId: null, defaultTemplate: null },
      { id: "wrong-category", slug: "home-goods", displayName: "Wrong", description: "Wrong", enabled: true, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: { ...template, categoryId: "other" } },
      { id: "disabled-template", slug: "home-goods", displayName: "Disabled template", description: "Disabled template", enabled: true, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: { ...template, enabled: false } },
      { id: "blank-template", slug: "home-goods", displayName: "Blank", description: "Blank", enabled: true, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: { ...template, promptText: "  \n" } },
      { id: "b", slug: "home-goods", displayName: "B", description: "B", enabled: true, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: { ...template, id: "template-b", categoryId: "b" } },
      { id: "a", slug: "home-goods", displayName: "A", description: "A", enabled: true, displayOrder: 1, defaultTemplateId: template.id, defaultTemplate: { ...template, id: "template-a", categoryId: "a" } },
    ];
    const findMany = vi.fn(async () => rows
      .filter((category) => category.enabled && category.defaultTemplateId !== null)
      .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id)));
    const client = { commercePromptTemplateCategory: { findMany } } as never;

    await expect(listSelectableStoreCategories("en", client)).resolves.toEqual([
      {
        id: "a",
        slug: "home-goods",
        localizedDisplayName: "Home goods",
        localizedDescription: "Home, kitchen, decor and everyday household products.",
        defaultTemplate: {
          id: "template-a",
          key: "home-goods.default",
          displayName: "Home goods",
          editVersion: 7,
        },
      },
      {
        id: "b",
        slug: "home-goods",
        localizedDisplayName: "Home goods",
        localizedDescription: "Home, kitchen, decor and everyday household products.",
        defaultTemplate: {
          id: "template-b",
          key: "home-goods.default",
          displayName: "Home goods",
          editVersion: 7,
        },
      },
      {
        id: "late",
        slug: "home-goods",
        localizedDisplayName: "Home goods",
        localizedDescription: "Home, kitchen, decor and everyday household products.",
        defaultTemplate: {
          id: "late-template",
          key: "home-goods.default",
          displayName: "Home goods",
          editVersion: 7,
        },
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    }));
    expect(JSON.stringify(await listSelectableStoreCategories("en", client))).not.toContain("Do not expose this prompt.");
  });
});