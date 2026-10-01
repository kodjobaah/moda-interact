import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsAccess: vi.fn(),
  createWebPageSource: vi.fn(),
  editWebPageSource: vi.fn(),
  refreshWebPageSource: vi.fn(),
  reorderMerchantKnowledgeSources: vi.fn(),
  deleteMerchantKnowledgeSource: vi.fn(),
  createMerchantKnowledgeUploadIntent: vi.fn(),
  finalizeMerchantKnowledgeUpload: vi.fn(),
  reprocessMerchantKnowledgeUpload: vi.fn(),
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
vi.mock("../../app/services/merchant-knowledge/upload.server", () => ({
  createMerchantKnowledgeUploadIntent: mocks.createMerchantKnowledgeUploadIntent,
  finalizeMerchantKnowledgeUpload: mocks.finalizeMerchantKnowledgeUpload,
  reprocessMerchantKnowledgeUpload: mocks.reprocessMerchantKnowledgeUpload,
  editMerchantKnowledgeUploadSource: vi.fn(),
}));

import { action as sourceAction } from "../../app/routes/app/merchant-knowledge/source/route";
import { action as reorderAction } from "../../app/routes/app/merchant-knowledge/reorder/route";
import { action as refreshAction } from "../../app/routes/app/merchant-knowledge/refresh/route";
import { action as deleteAction } from "../../app/routes/app/merchant-knowledge/delete/route";
import { action as uploadIntentAction } from "../../app/routes/app/merchant-knowledge/upload-intent/route";
import { action as uploadFinalizeAction } from "../../app/routes/app/merchant-knowledge/upload-finalize/route";
import { action as reprocessAction } from "../../app/routes/app/merchant-knowledge/reprocess/route";

type Action = (args: { request: Request }) => Promise<Response>;

async function post(action: Action, fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return action({
    request: new Request("https://app.example.test/", { method: "POST", body: form }),
  });
}

async function postJson(action: Action, body: Record<string, unknown>) {
  return action({
    request: new Request("https://app.example.test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
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
  mocks.createMerchantKnowledgeUploadIntent.mockResolvedValue({
    assetId: "asset-1",
    uploadUrl: "https://r2.example/signed-put",
    expiresAt: "2026-10-01T12:10:00.000Z",
    requiredHeaders: { "Content-Type": "text/csv" },
    maxUploadBytes: 1_000_000,
  });
  mocks.finalizeMerchantKnowledgeUpload.mockResolvedValue({ sourceId: "source-1", queued: false });
  mocks.reprocessMerchantKnowledgeUpload.mockResolvedValue({ ok: true });
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

it("returns only the signed intent contract and derives tenant identity from Shopify auth", async () => {
  const response = await postJson(uploadIntentAction as Action, {
    purposeKey: "FAQ",
    dataFormatKey: "CSV",
    originalFileName: "help.csv",
    contentType: "text/csv",
    sizeBytes: 42,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    assetId: "asset-1",
    uploadUrl: "https://r2.example/signed-put",
    expiresAt: "2026-10-01T12:10:00.000Z",
    requiredHeaders: { "Content-Type": "text/csv" },
    maxUploadBytes: 1_000_000,
  });
  expect(mocks.createMerchantKnowledgeUploadIntent).toHaveBeenCalledWith({
    shopId: "authenticated-shop",
    purposeKey: "FAQ",
    dataFormatKey: "CSV",
    originalFileName: "help.csv",
    contentType: "text/csv",
    sizeBytes: 42,
  });
});

it("rejects browser tenant/key fields before upload mutation", async () => {
  const response = await postJson(uploadIntentAction as Action, {
    purposeKey: "FAQ",
    dataFormatKey: "CSV",
    originalFileName: "help.csv",
    contentType: "text/csv",
    sizeBytes: 42,
    shopId: "attacker-shop",
    objectKey: "attacker-key",
  });
  expect(response.status).toBe(400);
  expect(mocks.createMerchantKnowledgeUploadIntent).not.toHaveBeenCalled();
});

it("routes upload finalization and reprocess with the authenticated shop only", async () => {
  const finalize = await postJson(uploadFinalizeAction as Action, {
    assetId: "asset-1",
    purposeKey: "FAQ",
    name: "Help file",
    languageTag: "en",
    sizeBytes: 42,
    sha256: "a".repeat(64),
    contentType: "text/csv",
  });
  const reprocess = await post(reprocessAction as Action, { sourceId: "source-1" });

  expect(finalize.status).toBe(200);
  expect(await finalize.json()).toEqual({ ok: true, sourceId: "source-1", queued: false });
  expect(reprocess.status).toBe(200);
  expect(mocks.finalizeMerchantKnowledgeUpload).toHaveBeenCalledWith(expect.objectContaining({
    shopId: "authenticated-shop",
    assetId: "asset-1",
  }));
  expect(mocks.reprocessMerchantKnowledgeUpload).toHaveBeenCalledWith({
    shopId: "authenticated-shop",
    sourceId: "source-1",
  });
});