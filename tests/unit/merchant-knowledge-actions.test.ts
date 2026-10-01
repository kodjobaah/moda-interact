import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsAccess: vi.fn(),
  createWebPageSource: vi.fn(),
  editWebPageSource: vi.fn(),
  refreshWebPageSource: vi.fn(),
  reorderMerchantKnowledgeSources: vi.fn(),
  deleteMerchantKnowledgeSource: vi.fn(),
}));

vi.mock("../../app/services/feature-preferences/access.server", () => ({
  settingsAccess: mocks.settingsAccess,
}));
vi.mock("../../app/services/merchant-knowledge/merchant-knowledge.server", () => ({
  createWebPageSource: mocks.createWebPageSource,
  editWebPageSource: mocks.editWebPageSource,
  refreshWebPageSource: mocks.refreshWebPageSource,
  reorderMerchantKnowledgeSources: mocks.reorderMerchantKnowledgeSources,
  deleteMerchantKnowledgeSource: mocks.deleteMerchantKnowledgeSource,
  MerchantKnowledgeError: class MerchantKnowledgeError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

import { action as sourceAction } from "../../app/routes/app/merchant-knowledge/source/route";
import { action as reorderAction } from "../../app/routes/app/merchant-knowledge/reorder/route";
import { action as refreshAction } from "../../app/routes/app/merchant-knowledge/refresh/route";
import { action as deleteAction } from "../../app/routes/app/merchant-knowledge/delete/route";

type Action = (args: { request: Request }) => Promise<Response>;

async function post(action: Action, fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return action({
    request: new Request("https://app.example.test/", { method: "POST", body: form }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsAccess.mockResolvedValue({ shop: { id: "authenticated-shop" } });
  mocks.createWebPageSource.mockResolvedValue({ sourceId: "source-1" });
  mocks.editWebPageSource.mockResolvedValue({ ok: true });
  mocks.refreshWebPageSource.mockResolvedValue({ ok: true });
  mocks.reorderMerchantKnowledgeSources.mockResolvedValue({ ok: true });
  mocks.deleteMerchantKnowledgeSource.mockResolvedValue({ ok: true });
});

it("uses the authenticated shop for create and edit and does not expose source content", async () => {
  const create = await post(sourceAction as Action, {
    operation: "create",
    name: "Help page",
    purposeKey: "FAQ",
    dataFormatKey: "WEB_PAGE",
    url: "https://example.test/help",
    languageTag: "en",
  });
  expect(create.status).toBe(200);
  expect(await create.json()).toEqual({ ok: true, sourceId: "source-1" });
  expect(mocks.createWebPageSource).toHaveBeenCalledWith(expect.objectContaining({
    shopId: "authenticated-shop",
  }));

  const edit = await post(sourceAction as Action, {
    operation: "edit",
    sourceId: "source-1",
    name: "Help page updated",
    url: "https://example.test/help",
    languageTag: "en",
  });
  expect(edit.status).toBe(200);
  expect(mocks.editWebPageSource).toHaveBeenCalledWith(expect.objectContaining({
    shopId: "authenticated-shop",
    sourceId: "source-1",
  }));
});

it("rejects browser-supplied shop IDs before source creation", async () => {
  const response = await post(sourceAction as Action, {
    operation: "create",
    name: "Help page",
    purposeKey: "FAQ",
    dataFormatKey: "WEB_PAGE",
    url: "https://example.test/help",
    languageTag: "en",
    shopId: "attacker-shop",
  });

  expect(response.status).toBe(400);
  expect(mocks.createWebPageSource).not.toHaveBeenCalled();
});

it("routes reorder, refresh, and delete only with the authenticated shop", async () => {
  const reorder = await post(reorderAction as Action, {
    sourceIds: JSON.stringify(["source-2", "source-1"]),
  });
  const refresh = await post(refreshAction as Action, { sourceId: "source-1" });
  const remove = await post(deleteAction as Action, { sourceId: "source-1" });

  expect(reorder.status).toBe(200);
  expect(refresh.status).toBe(200);
  expect(remove.status).toBe(200);
  expect(mocks.reorderMerchantKnowledgeSources).toHaveBeenCalledWith({
    shopId: "authenticated-shop",
    sourceIds: ["source-2", "source-1"],
  });
  expect(mocks.refreshWebPageSource).toHaveBeenCalledWith({
    shopId: "authenticated-shop",
    sourceId: "source-1",
  });
  expect(mocks.deleteMerchantKnowledgeSource).toHaveBeenCalledWith({
    shopId: "authenticated-shop",
    sourceId: "source-1",
  });
});

it("does not invoke a mutation when authenticated settings access fails", async () => {
  mocks.settingsAccess.mockRejectedValue(new Response(null, { status: 401 }));

  await expect(post(deleteAction as Action, { sourceId: "source-1" })).rejects.toMatchObject({
    status: 401,
  });
  expect(mocks.deleteMerchantKnowledgeSource).not.toHaveBeenCalled();
});