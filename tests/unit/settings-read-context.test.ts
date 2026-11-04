import { beforeEach, expect, it, vi } from "vitest";
import { RouterContextProvider } from "react-router";
import type { PrismaClient } from "@prisma/client";
import type { MerchantRequestContext } from "../../app/services/shop/merchant-request-context.server";
const source = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../app/services/shop/merchant-request-context.server", () => ({ getMerchantRequestContext: source.resolve }));
import { settingsAccess, settingsMutationAccess } from "../../app/services/feature-preferences/access.server";
import { loadSettingsReadContext } from "../../app/services/feature-preferences/settings-read-context.server";
import { loadFeaturePreferences, projectFeaturePreferences, revisionOf } from "../../app/services/feature-preferences/feature-preferences.server";
const timestamp = new Date("2026-11-04T00:00:00Z");
const shop = { id: "shop-1", status: "ACTIVE", defaultLanguageTag: "fr", onboardingCompleted: true };
const subscription = { planId: "plan-1", status: "ACTIVE" };
const feature = { id: "feature-1", key: "fixture", displayName: "Fixture", description: null, active: true, activationMode: "MERCHANT_OPT_IN", systemRequired: false, updatedAt: timestamp };
const plan = { id: "plan-1", active: true, features: [{ featureId: feature.id, enabled: true, feature }] };
const preferences = [{ featureId: feature.id, enabled: true, updatedAt: timestamp }];
function fixture() {
 const settings = { aiResponseDelayMinutes: 7 };
 const merchant = { shop, authentication: { session: { shop: "fixture.myshopify.com" } }, readSubscription: vi.fn().mockResolvedValue(subscription), readSettings: vi.fn().mockResolvedValue(settings) };
 const client = { billingPlan: { findUnique: vi.fn().mockResolvedValue(plan) }, shopFeaturePreference: { findMany: vi.fn().mockResolvedValue(preferences) } };
 return { merchant, client, settings };
}
beforeEach(() => vi.clearAllMocks());
it("passes the actual framework context and performs zero settings reads for mutation admission", async () => {
 const { merchant } = fixture(); source.resolve.mockResolvedValue(merchant);
 const request = new Request("https://app.test/settings", { method: "POST" });
 const context = new RouterContextProvider();
 expect((await settingsMutationAccess(request, context)).merchant).toBe(merchant);
 expect(source.resolve).toHaveBeenCalledWith({ request, context });
 expect(merchant.readSettings).not.toHaveBeenCalled();
 expect(merchant.readSubscription).toHaveBeenCalledOnce();
 await settingsAccess(request, context); expect(merchant.readSettings).toHaveBeenCalledOnce();
});
it("loads scalar getters and one ordered plan and preference projection without discarding mappings", async () => {
 const { merchant, client, settings } = fixture();
 const facts = await loadSettingsReadContext(merchant as never, client as unknown as PrismaClient);
 expect(facts.settings).toBe(settings); expect(facts.shop).toEqual({ id: shop.id, status: shop.status, defaultLanguageTag: shop.defaultLanguageTag });
 expect(merchant.readSubscription).toHaveBeenCalledOnce(); expect(merchant.readSettings).toHaveBeenCalledOnce();
 expect(client.billingPlan.findUnique).toHaveBeenCalledWith({ where: { id: "plan-1" }, include: { features: { include: { feature: true }, orderBy: [{ feature: { displayName: "asc" } }, { featureId: "asc" }] } } });
 expect(client.shopFeaturePreference.findMany).toHaveBeenCalledWith({ where: { shopId: shop.id }, orderBy: { featureId: "asc" } });
 expect(projectFeaturePreferences(facts).revision).toBe(revisionOf({ planId: plan.id, mappings: [[feature.id, timestamp, true]], preferences: [[feature.id, true, timestamp]] }));
});
it("pure projection matches the fresh transactional loader including revision bytes", async () => {
 const { merchant, client } = fixture();
 const facts = await loadSettingsReadContext(merchant as unknown as MerchantRequestContext, client as unknown as PrismaClient);
 const tx = { ...client, subscription: { findUnique: vi.fn().mockResolvedValue({ ...subscription, plan, shop }) } };
 expect(await loadFeaturePreferences(shop.id, tx as never)).toEqual(projectFeaturePreferences(facts));
 expect(tx.subscription.findUnique).toHaveBeenCalledOnce();
});
it.each([null, { ...plan, active: false }])("keeps absent/inactive plans denied without inventing replacements", async missing => {
 const { merchant, client } = fixture(); client.billingPlan.findUnique.mockResolvedValue(missing);
 merchant.readSettings.mockResolvedValue(null);
 const facts = await loadSettingsReadContext(merchant as never, client as unknown as PrismaClient);
 expect(facts.settings).toBeNull(); expect(facts.plan).toBe(missing);
 expect(() => projectFeaturePreferences(facts)).toThrow("DENIED");
});
it("does not read a plan for a subscription without a planId", async () => {
 const { merchant, client } = fixture(); merchant.readSubscription.mockResolvedValue({ ...subscription, planId: null });
 const facts = await loadSettingsReadContext(merchant as never, client as unknown as PrismaClient);
 expect(facts.plan).toBeNull(); expect(client.billingPlan.findUnique).not.toHaveBeenCalled();
});
it.each(["ACTIVE", "TRIALING"])("mutation guard retains %s subscription admission without reading settings", async status => {
 const { merchant } = fixture(); merchant.readSubscription.mockResolvedValue({ ...subscription, status }); source.resolve.mockResolvedValue(merchant);
 await expect(settingsMutationAccess(new Request("https://app.test/settings", { method: "POST" }), new RouterContextProvider())).resolves.toMatchObject({ shop });
 expect(merchant.readSettings).not.toHaveBeenCalled();
});
it.each(["CANCELLED", "EXPIRED"])("mutation guard retains denial for %s subscriptions", async status => {
 const { merchant } = fixture(); merchant.readSubscription.mockResolvedValue({ ...subscription, status }); source.resolve.mockResolvedValue(merchant);
 await expect(settingsMutationAccess(new Request("https://app.test/settings", { method: "POST" }), new RouterContextProvider())).rejects.toMatchObject({ status: 302 });
 expect(merchant.readSettings).not.toHaveBeenCalled();
});
it("fresh transaction denial still precedes preference reads", async () => {
 const tx = { subscription: { findUnique: vi.fn().mockResolvedValue({ ...subscription, plan: { ...plan, active: false }, shop }) }, shopFeaturePreference: { findMany: vi.fn() } };
 await expect(loadFeaturePreferences(shop.id, tx as never)).rejects.toThrow("DENIED");
 expect(tx.shopFeaturePreference.findMany).not.toHaveBeenCalled();
});
