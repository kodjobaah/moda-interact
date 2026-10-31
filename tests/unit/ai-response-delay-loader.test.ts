import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsAccess: vi.fn(),
  loadRecoveryPolicySnapshot: vi.fn(),
  loadFeaturePreferences: vi.fn(),
  loadMerchantKnowledge: vi.fn(),
  listSelectableStoreCategories: vi.fn(),
  loadStoreProfile: vi.fn(),
  merchantUiContext: vi.fn(),
}));

vi.mock("@/services/feature-preferences/access.server", () => ({
  settingsAccess: mocks.settingsAccess,
}));
vi.mock("@/services/ai-response-delay/ai-response-delay.server", () => ({
  AiResponseDelayValidationError: class AiResponseDelayValidationError extends Error {},
  saveAiResponseDelay: vi.fn(),
}));
vi.mock("@/services/feature-preferences/feature-preferences.server", () => ({
  loadFeaturePreferences: mocks.loadFeaturePreferences,
  PreferenceError: class PreferenceError extends Error {},
}));
vi.mock("@/services/recovery-policy/recovery-policy.server", () => ({
  loadRecoveryPolicySnapshot: mocks.loadRecoveryPolicySnapshot,
}));
vi.mock("@/services/merchant-knowledge/merchant-knowledge.server", () => ({
  loadMerchantKnowledge: mocks.loadMerchantKnowledge,
}));
vi.mock("@/services/store-profile/store-category.server", () => ({
  listSelectableStoreCategories: mocks.listSelectableStoreCategories,
  loadStoreProfile: mocks.loadStoreProfile,
}));
vi.mock("@/utils/merchant-i18n", () => ({
  merchantUiContext: mocks.merchantUiContext,
}));

import { loader } from "@/routes/app/recovery-settings/route";

describe("AI response delay settings loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsAccess.mockResolvedValue({
      shop: { id: "authenticated-shop" },
      session: { id: "session" },
      settings: { aiResponseDelayMinutes: 7 },
    });
    mocks.merchantUiContext.mockReturnValue({ locale: "en" });
    mocks.listSelectableStoreCategories.mockResolvedValue([]);
    mocks.loadStoreProfile.mockResolvedValue(null);
    mocks.loadMerchantKnowledge.mockResolvedValue(null);
    mocks.loadFeaturePreferences.mockResolvedValue({ revision: "revision", features: [] });
    mocks.loadRecoveryPolicySnapshot.mockResolvedValue({ revision: "revision" });
  });

  it("returns the delay from authenticated shop settings", async () => {
    const result = await loader({
      request: new Request("https://merchant.example/app/recovery-settings"),
    } as never);

    expect(mocks.settingsAccess).toHaveBeenCalledOnce();
    expect(mocks.loadRecoveryPolicySnapshot).toHaveBeenCalledWith("authenticated-shop");
    expect(result.aiResponseDelayMinutes).toBe(7);
  });

  it("uses zero when the shop has no persisted settings yet", async () => {
    mocks.settingsAccess.mockResolvedValue({
      shop: { id: "authenticated-shop" },
      session: { id: "session" },
      settings: null,
    });

    const result = await loader({
      request: new Request("https://merchant.example/app/recovery-settings"),
    } as never);

    expect(result.aiResponseDelayMinutes).toBe(0);
  });
});
