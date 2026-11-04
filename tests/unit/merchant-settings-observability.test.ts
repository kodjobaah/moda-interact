import { beforeEach, expect, it, vi } from "vitest";
const output = vi.hoisted(() => ({ records: [] as unknown[], broken: false }));
vi.mock("@modainteract/moda-interact-shared/logging", async importOriginal => {
 const actual = await importOriginal<typeof import("@modainteract/moda-interact-shared/logging")>();
 return { ...actual, createLogger: (options: Parameters<typeof actual.createLogger>[0]) => actual.createLogger({ ...options, sink: record => {
  if (output.broken) throw new Error("broken-sink"); output.records.push(JSON.parse(JSON.stringify(record)));
 } }) };
});
const render = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@modainteract/moda-interact-shared/commerce", async original => ({ ...await original<object>(), renderStoreCategoryPromptTemplate: render.run }));
import { recordMerchantSettingsFailure } from "../../app/services/feature-preferences/merchant-settings-observability.server";
import { loadSettingsReadContext } from "../../app/services/feature-preferences/settings-read-context.server";
import { loadRecoveryPolicySnapshot } from "../../app/services/recovery-policy/recovery-policy.server";
import { selectPendingStoreCategory } from "../../app/services/store-profile/store-category-selection.server";
const failure = () => Object.assign(new Error("Invalid Prisma invocation:\nconstraint failure marker email=private@example.test postgres://secret-host/db", { cause: new Error("original-cause access_token=private-token") }), { code: "P2021" });
beforeEach(() => { output.records.length = 0; output.broken = false; });
it.each(["read", "save", "category"] as const)("preserves original multiline message/code/cause at %s with redaction", boundary => {
 const error = failure(); recordMerchantSettingsFailure(boundary, "fixture", "shop-1", error);
 const json = JSON.stringify(output.records);
 for (const marker of ["constraint failure marker", "original-cause", "P2021"]) expect(json).toContain(marker);
 for (const secret of ["private@example.test", "secret-host", "private-token"]) expect(json).not.toContain(secret);
 expect(json).toContain('"redactionApplied":true'); expect(error.cause).toBeInstanceOf(Error);
});
it.each(["plan", "preferences", "override", "catalogue"])("owns %s read failure and preserves rejection with a throwing real Shared sink", async stage => {
 for (const broken of [false, true]) {
  output.records.length = 0; output.broken = broken; const error = failure();
  const read = vi.fn().mockRejectedValue(error);
  const client = { billingPlan: { findUnique: stage === "plan" ? read : vi.fn().mockResolvedValue(null) }, shopFeaturePreference: { findMany: stage === "preferences" ? read : vi.fn().mockResolvedValue([]) }, shopSettings: { findUnique: vi.fn().mockResolvedValue(null) }, shopRecoveryPolicyOverride: { findFirst: stage === "override" ? read : vi.fn().mockResolvedValue(null) }, shopifyDiscountCatalogue: { findUnique: stage === "catalogue" ? read : vi.fn().mockResolvedValue(null) } };
  const merchant = { shop: { id: "shop-1" }, readSubscription: async () => ({ planId: "plan-1" }), readSettings: async () => null };
  const run = ["plan", "preferences"].includes(stage) ? loadSettingsReadContext(merchant as never, client as never) : loadRecoveryPolicySnapshot("shop-1", undefined, client as never);
  await expect(run).rejects.toBe(error); expect(output.records).toHaveLength(broken ? 0 : 1);
 }
});
it("does not duplicate scalar-context source failures", async () => {
 const error = failure(); const merchant = { readSubscription: async () => { throw error; }, readSettings: async () => null };
 await expect(loadSettingsReadContext(merchant as never, {} as never)).rejects.toBe(error); expect(output.records).toHaveLength(0);
});
it.each([false, true])("logs render failure before typed wrapping and preserves cause with broken sink=%s", async broken => {
 output.broken = broken; const error = failure(); render.run.mockImplementation(() => { throw error; });
 const category = { id: "category", enabled: true, editVersion: 1, taxonomyMappings: [], defaultTemplate: { id: "template", categoryId: "category", enabled: true, editVersion: 1, promptText: "private prompt sentinel" } };
 const client = { commerceShopProfile: { findUnique: async () => null }, commercePromptTemplateCategory: { findUnique: async () => category }, $transaction: vi.fn() };
 await expect(selectPendingStoreCategory({ shopId: "shop-1", categoryId: "category", expectedPendingSelectionGeneration: 0 }, client as never)).rejects.toMatchObject({ code: "CATEGORY_UNAVAILABLE", cause: error });
 expect(client.$transaction).not.toHaveBeenCalled(); expect(output.records).toHaveLength(broken ? 0 : 1);
 expect(JSON.stringify(output.records)).not.toContain("private prompt sentinel");
});

vi.mock("../../app/services/feature-preferences/access.server", () => ({ settingsMutationAccess: async () => ({ shop: { id: "shop-1" } }) }));
const categoryAccess = vi.hoisted(() => ({ get: vi.fn(async () => ({ shop: { id: "shop-1", status: "ACTIVE" } })) }));
vi.mock("../../app/services/shop/merchant-request-context.server", () => ({ getMerchantRequestContext: categoryAccess.get }));
import * as features from "../../app/services/feature-preferences/feature-preferences.server";
import * as policy from "../../app/services/recovery-policy/recovery-policy.server";
import * as delay from "../../app/services/ai-response-delay/ai-response-delay.server";
import * as categoryService from "../../app/services/store-profile/store-category-selection.server";
import { action as saveAction } from "../../app/routes/app/settings-save/route";
import { action as categoryAction } from "../../app/routes/app/store-profile/category/route";
import { RouterContextProvider } from "react-router";
it.each(["features", "recovery", "ai-response-delay"])("owns %s save errors with original diagnostics and unchanged rejection", async intent => {
 for (const broken of [false, true]) {
  output.records.length = 0; output.broken = broken; const error = failure();
  const spy = intent === "features" ? vi.spyOn(features, "saveFeaturePreferences") : intent === "recovery" ? vi.spyOn(policy, "saveMerchantRecoveryPolicy") : vi.spyOn(delay, "saveAiResponseDelay");
  spy.mockRejectedValueOnce(error);
  const fields: Record<string, string> = intent === "features" ? { preferences: "[]" } : intent === "recovery" ? { recoveryDelayMinutes: "30", recoveryOfferMode: "NONE", selectedDiscountIds: "[]", followUpEnabled: "false", followUpDelayMinutes: "", notifyOnInitialRecoveryOutreach: "true" } : { aiResponseDelayMinutes: "7" };
  const body = new URLSearchParams({ intent, operationId: "fixture-op", revision: "revision", ...fields });
  try {
   await expect(saveAction({ request: new Request("https://app.test/settings", { method: "POST", body }), context: new RouterContextProvider() } as never)).rejects.toBe(error);
   expect(output.records).toHaveLength(broken ? 0 : 1);
   if (!broken) { const json = JSON.stringify(output.records); expect(json).toContain(intent); expect(json).toContain("constraint failure marker"); expect(json).toContain("P2021"); expect(json).toContain("original-cause"); }
  } finally { spy.mockRestore(); }
 }
});
it.each(["SHOP_UNAVAILABLE", "CONFLICT", "CATEGORY_UNAVAILABLE", "database"])("category action preserves %s outcome and actual framework context", async code => {
 const context = new RouterContextProvider(); const error = code === "database" ? failure() : new categoryService.StoreCategorySelectionError(code as "CONFLICT");
 const spy = vi.spyOn(categoryService, "selectPendingStoreCategory").mockRejectedValueOnce(error);
 const request = new Request("https://app.test/category", { method: "POST", body: new URLSearchParams({ categoryId: "category", expectedPendingSelectionGeneration: "0" }) });
 try {
  const operation = categoryAction({ request, context } as never);
  if (code === "database") { await expect(operation).rejects.toBe(error); expect(JSON.stringify(output.records)).toContain("P2021"); }
  else { const response = await operation; expect(response.status).toBe(code === "SHOP_UNAVAILABLE" ? 403 : code === "CONFLICT" ? 409 : 400); expect(await response.json()).toEqual({ ok: false, error: code }); expect(output.records).toHaveLength(0); }
  expect(categoryAccess.get).toHaveBeenCalledWith({ request, context });
 } finally { spy.mockRestore(); }
});
