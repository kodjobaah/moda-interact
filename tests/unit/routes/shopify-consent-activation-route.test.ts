import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsMutationAccess: vi.fn(),
  resolveConsentPlacement: vi.fn(),
  reconcileCartConsentGate: vi.fn(),
  loadCartConsentSetupSnapshot: vi.fn(),
  loadCartConsentBlockPresence: vi.fn(),
  loadConsentActivation: vi.fn(),
  transitionCartConsentSetupPhase: vi.fn(),
  buildCartConsentThemeEditorUrl: vi.fn(),
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
  loadCartConsentSetupSnapshot: mocks.loadCartConsentSetupSnapshot,
  loadCartConsentBlockPresence: mocks.loadCartConsentBlockPresence,
  loadConsentActivation: mocks.loadConsentActivation,
  transitionCartConsentSetupPhase: mocks.transitionCartConsentSetupPhase,
  buildCheckoutEditorUrl: mocks.buildCheckoutEditorUrl,
}));
vi.mock("@/services/shopify-consent/theme-activation-url.server", () => ({
  buildCartConsentThemeActivationUrl: mocks.buildCartConsentThemeActivationUrl,
  buildCartConsentThemeEditorUrl: mocks.buildCartConsentThemeEditorUrl,
}));
vi.mock("@/services/shopify-consent/consent-receipt.server", () => ({
  logShopifyConsentFailure: mocks.logShopifyConsentFailure,
}));
vi.mock("@/shopify.server", () => ({ apiKey: "test-key" }));

const { action } = await import("@/routes/app/consent-activate/route");
const makeRequest = (intent = "activate") => new Request("https://test.example/app/consent-activate", {
  method: "POST", body: new URLSearchParams({ intent }),
});
const invoke = (request = makeRequest()) =>
  action({ request, params: {}, context: undefined } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsMutationAccess.mockResolvedValue({
    shop: { id: "shop-1", domain: "merchant.myshopify.com" },
    merchant: { authentication: { admin: { graphql: vi.fn() } } },
  });
  mocks.resolveConsentPlacement.mockResolvedValue("non_plus_cart");
  mocks.reconcileCartConsentGate.mockResolvedValue("enabled");
  mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "disabled", setupPhase: "never" });
  mocks.loadCartConsentBlockPresence.mockResolvedValue("unknown");
  mocks.transitionCartConsentSetupPhase.mockResolvedValue("changed");
  mocks.buildCartConsentThemeActivationUrl.mockReturnValue(
    "https://merchant.myshopify.com/admin/themes/current/editor?template=cart&addAppBlockId=test-key%2Fcart-consent",
  );
  mocks.buildCartConsentThemeEditorUrl.mockReturnValue(
    "https://merchant.myshopify.com/admin/themes/current/editor?template=cart",
  );
  mocks.buildCheckoutEditorUrl.mockReturnValue("https://merchant.myshopify.com/admin/settings/checkout/editor?page=checkout&context=apps");
});

describe("authenticated Shopify cart consent setup lifecycle", () => {
  it("first-time setup claims progress and auto-adds even when theme inspection is unavailable", async () => {
    const result = await invoke();
    expect(result.status).toBe(200);
    expect((await result.json()).editorUrl).toContain("addAppBlockId");
    expect(mocks.transitionCartConsentSetupPhase).toHaveBeenCalledWith(
      expect.anything(), "never", "started", { enableGate: true },
    );
    expect(mocks.reconcileCartConsentGate).toHaveBeenCalledWith(expect.anything(), "non_plus_cart");
  });

  it("does not auto-add when an existing block is present or disabled", async () => {
    for (const presence of ["enabled", "disabled", "duplicate"]) {
      mocks.loadCartConsentBlockPresence.mockResolvedValueOnce(presence);
      const result = await invoke();
      expect((await result.json()).editorUrl).not.toContain("addAppBlockId");
    }
  });

  it.each(["started", "restoring"])("reopening phase %s never auto-adds a second copy", async (phase) => {
    mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "enabled", setupPhase: phase });
    const result = await invoke();
    expect((await result.json()).editorUrl).not.toContain("addAppBlockId");
    expect(mocks.transitionCartConsentSetupPhase).not.toHaveBeenCalled();
  });

  it("one-click restoration requires previous verified activity and positive absence", async () => {
    mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "enabled", setupPhase: "active" });
    mocks.loadCartConsentBlockPresence.mockResolvedValue("absent");
    const result = await invoke();
    expect((await result.json()).editorUrl).toContain("addAppBlockId");
    expect(mocks.transitionCartConsentSetupPhase).toHaveBeenCalledWith(
      expect.anything(), "active", "restoring",
    );
  });

  it.each(["enabled", "disabled", "duplicate", "unknown"])(
    "never inserts another block when prior active placement is %s", async (presence) => {
      mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "enabled", setupPhase: "active" });
      mocks.loadCartConsentBlockPresence.mockResolvedValue(presence);
      const result = await invoke();
      expect((await result.json()).editorUrl).not.toContain("addAppBlockId");
      expect(mocks.transitionCartConsentSetupPhase).not.toHaveBeenCalled();
    },
  );

  it("can recover an older gate-enabled install when the published block is verified absent", async () => {
    mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "enabled", setupPhase: "never" });
    mocks.loadCartConsentBlockPresence.mockResolvedValue("absent");
    const result = await invoke();
    expect((await result.json()).editorUrl).toContain("addAppBlockId");
    expect(mocks.transitionCartConsentSetupPhase).toHaveBeenCalledWith(
      expect.anything(), "never", "started", { enableGate: false },
    );
  });

  it("does not auto-add on a legacy gate when block evidence is unavailable", async () => {
    mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "enabled", setupPhase: "never" });
    mocks.loadCartConsentBlockPresence.mockResolvedValue("unknown");
    const result = await invoke();
    expect((await result.json()).editorUrl).not.toContain("addAppBlockId");
  });

  it("on a concurrent CAS loser opens the safe editor rather than duplicating", async () => {
    mocks.transitionCartConsentSetupPhase.mockResolvedValue("conflict");
    const result = await invoke();
    expect((await result.json()).editorUrl).not.toContain("addAppBlockId");
  });

  it("only a positively verified Active placement advances setup to active", async () => {
    mocks.loadConsentActivation.mockResolvedValue({
      placement: "non_plus_cart", cartStatus: "active", gateState: "enabled", setupPhase: "started",
    });
    const response = await invoke(makeRequest("verify"));
    expect(response.status).toBe(200);
    expect(mocks.transitionCartConsentSetupPhase).toHaveBeenCalledWith(
      expect.anything(), "started", "active",
    );
    mocks.transitionCartConsentSetupPhase.mockClear();
    mocks.loadConsentActivation.mockResolvedValue({
      placement: "non_plus_cart", cartStatus: "unavailable", setupPhase: "started",
    });
    expect((await (await invoke(makeRequest("verify"))).json()).status).toBe("unavailable");
    expect(mocks.transitionCartConsentSetupPhase).not.toHaveBeenCalled();
  });

  it("reconciles a verified published block when the Shopify setup metafield is missing", async () => {
    mocks.loadConsentActivation.mockResolvedValue({
      placement: "non_plus_cart", cartStatus: "active", gateState: "enabled", setupPhase: "never",
    });
    const result = await invoke(makeRequest("verify"));
    expect(result.status).toBe(200);
    expect((await result.json()).status).toBe("active");
    expect(mocks.transitionCartConsentSetupPhase).toHaveBeenCalledWith(
      expect.anything(), "never", "active",
    );
  });

  it("does not write a missing phase unless published placement and gate are verified", async () => {
    for (const [status, gateState] of [["unavailable", "enabled"], ["active", "unknown"], ["active", "disabled"]]) {
      mocks.transitionCartConsentSetupPhase.mockClear();
      mocks.loadConsentActivation.mockResolvedValue({
        placement: "non_plus_cart", cartStatus: status, gateState, setupPhase: "never",
      });
      expect((await invoke(makeRequest("verify"))).status).toBe(200);
      expect(mocks.transitionCartConsentSetupPhase).not.toHaveBeenCalled();
    }
  });

  it("checks a concurrent phase update before reporting reconciliation success", async () => {
    mocks.loadConsentActivation.mockResolvedValue({
      placement: "non_plus_cart", cartStatus: "active", gateState: "enabled", setupPhase: "never",
    });
    mocks.transitionCartConsentSetupPhase.mockResolvedValue("conflict");
    mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "enabled", setupPhase: "started" });
    expect((await invoke(makeRequest("verify"))).status).toBe(503);
    expect(mocks.logShopifyConsentFailure).toHaveBeenCalledWith(expect.objectContaining({
      stage: "merchant_verification",
    }));
    mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "enabled", setupPhase: "active" });
    expect((await invoke(makeRequest("verify"))).status).toBe(200);
  });

  it("returns 503 on unknown setup evidence without opening a second add-block link", async () => {
    mocks.loadCartConsentSetupSnapshot.mockResolvedValue({ gateState: "unknown", setupPhase: "unknown" });
    expect((await invoke()).status).toBe(503);
    expect(mocks.buildCartConsentThemeActivationUrl).not.toHaveBeenCalled();
  });

  it("supports Shopify Plus without a cart block and rejects client-supplied plan fields", async () => {
    mocks.resolveConsentPlacement.mockResolvedValue("plus_checkout");
    mocks.reconcileCartConsentGate.mockResolvedValue("disabled");
    expect((await (await invoke()).json()).editorUrl).toBe(
      "https://merchant.myshopify.com/admin/settings/checkout/editor?page=checkout&context=apps",
    );
    expect(mocks.buildCheckoutEditorUrl).toHaveBeenCalledWith("merchant.myshopify.com");
    expect(mocks.buildCartConsentThemeActivationUrl).not.toHaveBeenCalled();
    const invalid = new Request("https://test.example/app/consent-activate", {
      method: "POST", body: new URLSearchParams({ intent: "activate", plan: "plus_checkout" }),
    });
    expect((await invoke(invalid)).status).toBe(400);
  });

  it("preserves authorization and logs real provider failures", async () => {
    mocks.settingsMutationAccess.mockRejectedValueOnce(new Response(null, { status: 403 }));
    await expect(invoke()).rejects.toMatchObject({ status: 403 });
    mocks.reconcileCartConsentGate.mockRejectedValueOnce(new Error("Shopify provider message"));
    expect((await invoke()).status).toBe(503);
    expect(mocks.logShopifyConsentFailure).toHaveBeenCalledWith(expect.objectContaining({
      stage: "merchant_activation", error: expect.any(Error),
    }));
  });
});
