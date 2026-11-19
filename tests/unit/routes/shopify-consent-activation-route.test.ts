import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsMutationAccess: vi.fn(),
  resolveConsentPlacement: vi.fn(),
  reconcileCartConsentGate: vi.fn(),
  buildCartConsentThemeActivationUrl: vi.fn(),
  buildCheckoutEditorUrl: vi.fn(),
  logShopifyConsentFailure: vi.fn(),
}));
vi.mock("@/services/feature-preferences/access.server", () => ({
  settingsMutationAccess: mocks.settingsMutationAccess,
}));
vi.mock("@/services/shopify-consent/consent-activation.server", () => ({
  resolveConsentPlacement: mocks.resolveConsentPlacement,
  reconcileCartConsentGate: mocks.reconcileCartConsentGate,
  buildCheckoutEditorUrl: mocks.buildCheckoutEditorUrl,
}));
vi.mock("@/services/shopify-consent/theme-activation-url.server", () => ({
  buildCartConsentThemeActivationUrl: mocks.buildCartConsentThemeActivationUrl,
}));
vi.mock("@/services/shopify-consent/consent-receipt.server", () => ({
  logShopifyConsentFailure: mocks.logShopifyConsentFailure,
}));
vi.mock("@/shopify.server", () => ({ apiKey: "test-key" }));

const { action } = await import("@/routes/app/consent-activate/route");

const makeRequest = (intent = "activate") => new Request("https://test.example/app/consent-activate", {
  method: "POST",
  body: new URLSearchParams({ intent }),
});

async function activate(request = makeRequest()) {
  return action({ request, params: {}, context: undefined } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsMutationAccess.mockResolvedValue({
    shop: { id: "shop-1", domain: "merchant.myshopify.com" },
    merchant: { authentication: { admin: { graphql: vi.fn() } } },
  });
  mocks.buildCartConsentThemeActivationUrl.mockReturnValue("https://merchant.myshopify.com/admin/themes/current/editor");
  mocks.buildCheckoutEditorUrl.mockReturnValue("https://merchant.myshopify.com/admin/settings/checkout");
});

describe("authenticated Shopify consent activation", () => {
  it("prepares only the non-Plus cart gate and returns its editor", async () => {
    mocks.resolveConsentPlacement.mockResolvedValue("non_plus_cart");
    mocks.reconcileCartConsentGate.mockResolvedValue("enabled");
    const response = await activate();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true, placement: "non_plus_cart",
      editorUrl: "https://merchant.myshopify.com/admin/themes/current/editor",
    });
    expect(mocks.reconcileCartConsentGate).toHaveBeenCalledWith(expect.anything(), "non_plus_cart");
    expect(mocks.buildCheckoutEditorUrl).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("disables the old cart gate when the verified plan is Plus", async () => {
    mocks.resolveConsentPlacement.mockResolvedValue("plus_checkout");
    mocks.reconcileCartConsentGate.mockResolvedValue("disabled");
    const response = await activate();
    expect(response.status).toBe(200);
    expect(mocks.reconcileCartConsentGate).toHaveBeenCalledWith(expect.anything(), "plus_checkout");
    expect(mocks.buildCartConsentThemeActivationUrl).not.toHaveBeenCalled();
  });

  it("never mutates a gate when Shopify plan verification is unavailable", async () => {
    mocks.resolveConsentPlacement.mockResolvedValue("unknown");
    const response = await activate();
    expect(response.status).toBe(503);
    expect(mocks.reconcileCartConsentGate).not.toHaveBeenCalled();
  });

  it("refuses extra client plan fields and unauthorised access", async () => {
    const invalid = new Request("https://test.example/app/consent-activate", {
      method: "POST",
      body: new URLSearchParams({ intent: "activate", plan: "plus_checkout" }),
    });
    expect((await activate(invalid)).status).toBe(400);
    expect(mocks.resolveConsentPlacement).not.toHaveBeenCalled();
    mocks.settingsMutationAccess.mockRejectedValueOnce(new Response(null, { status: 403 }));
    await expect(activate()).rejects.toMatchObject({ status: 403 });
  });

  it("returns retryable setup failure if Shopify rejects gate reconciliation", async () => {
    mocks.resolveConsentPlacement.mockResolvedValue("non_plus_cart");
    mocks.reconcileCartConsentGate.mockRejectedValue(new Error("Shopify metafieldsSet rejected"));
    const response = await activate();
    expect(response.status).toBe(503);
    expect(mocks.logShopifyConsentFailure).toHaveBeenCalledWith(expect.objectContaining({
      stage: "merchant_activation", error: expect.any(Error),
    }));
  });
});
