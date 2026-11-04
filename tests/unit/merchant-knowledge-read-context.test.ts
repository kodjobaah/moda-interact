import { expect, it, vi } from "vitest";
vi.mock("../../app/db.server", () => ({default: {}}));
vi.mock("../../app/services/platform-configuration/composition.server", () => ({createDefaultShopifyPlatformConfigurationService: () => ({requireMerchantKnowledgeR2Configuration: async () => ({maxUploadBytes: 10})})}));
import { loadMerchantKnowledge } from "../../app/services/merchant-knowledge/merchant-knowledge.server";
import type { SettingsReadContext } from "../../app/services/feature-preferences/settings-read-context.server";
function fixture(mapped = true) {
 const feature = {id: "feature", key: "merchant_knowledge", active: true, activationMode: "MERCHANT_OPT_IN"};
 const context = {shop: {id: "shop", status: "ACTIVE", defaultLanguageTag: "fr"}, subscription: {status: "ACTIVE", planId: "plan"}, settings: null,
  plan: {active: true, features: mapped ? [{enabled: true, feature, configuration: {schemaVersion: 1, maxKnowledgeSources: 2, maxContentUnitsPerSource: 1000, allowedSourceTypes: [{purposeKey: "FAQ", dataFormatKey: "WEB_PAGE"}]}}] : []},
  preferences: [{featureId: "feature", enabled: true}]} as unknown as SettingsReadContext;
 const database = {subscription: {findUnique: vi.fn()}, shop: {findUnique: vi.fn()}, shopFeaturePreference: {findUnique: vi.fn()},
  feature: {findUnique: vi.fn().mockResolvedValue(feature)}, merchantKnowledgeSource: {findMany: vi.fn().mockResolvedValue([])},
  merchantKnowledgeSourceRevision: {findMany: vi.fn().mockResolvedValue([])}, merchantKnowledgePurposeDataFormat: {findMany: vi.fn().mockResolvedValue([])}};
 return {context, database};
}
it.each([true, false])("reuses all supplied facts, mapped=%s, with only global-feature fallback when needed", async mapped => {
 const f = fixture(mapped); const result = await loadMerchantKnowledge("shop", f.database as never, f.context);
 expect(result.entitlementState).toBe(mapped ? "entitled" : "denied"); expect(result.merchantEnabled).toBe(true); expect(result.defaultLanguageTag).toBe("fr");
 expect(f.database.subscription.findUnique).not.toHaveBeenCalled(); expect(f.database.shop.findUnique).not.toHaveBeenCalled(); expect(f.database.shopFeaturePreference.findUnique).not.toHaveBeenCalled();
 expect(f.database.feature.findUnique).toHaveBeenCalledTimes(mapped ? 0 : 1);
});
it("rejects a foreign context before reads", async () => {
 const f = fixture(); await expect(loadMerchantKnowledge("foreign", f.database as never, f.context)).rejects.toMatchObject({code: "DENIED"});
 expect(f.database.merchantKnowledgeSource.findMany).not.toHaveBeenCalled();
});
it("malformed configuration is unavailable with retained source rows and no fabricated plan-denial reason", async () => {
 const f = fixture(); f.context.plan!.features[0].configuration = {};
 f.database.merchantKnowledgeSource.findMany.mockResolvedValue([{id: "retained", name: "Retained", languageTag: "en", position: 0, currentGeneration: 1, purpose: {key: "FAQ", displayName: "FAQ", active: true}, dataFormat: {key: "WEB_PAGE", displayName: "Web", active: true}, revisions: []}] as never);
 const result = await loadMerchantKnowledge("shop", f.database as never, f.context);
 expect(result.entitlementState).toBe("unavailable"); expect(result.sources).toMatchObject([{id: "retained", dormantReason: null, processingEligible: false}]);
});

it.each([null, {id: "feature", active: false, activationMode: "MERCHANT_OPT_IN"}, {id: "feature", active: true, activationMode: "ALWAYS_ENABLED"}])("fallback uses actual missing/inactive/non-opt-in global Feature policy", async globalFeature => {
 const f = fixture(false); f.database.feature.findUnique.mockResolvedValue(globalFeature as never);
 const result = await loadMerchantKnowledge("shop", f.database as never, f.context);
 expect(result.merchantEnabled).toBe(false); expect(f.database.shopFeaturePreference.findUnique).not.toHaveBeenCalled();
});
