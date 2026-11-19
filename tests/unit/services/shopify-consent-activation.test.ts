import { describe, expect, it } from "vitest";
import {
  loadConsentActivation,
  resolveConsentPlacement,
  type AdminGraphqlClient,
  reconcileCartConsentGate,
  loadCartConsentGateState,
} from "../../../app/services/shopify-consent/consent-activation.server";
import { CART_CONSENT_EXTENSION_UID } from "../../../app/services/shopify-consent/theme-activation-status";

function adminWith(handlers: Record<string, unknown | Error>): AdminGraphqlClient {
  return {
    async graphql(query: string) {
      const key = Object.keys(handlers).find((name) => query.includes(name));
      const payload = key ? handlers[key] : new Error("Unexpected query.");
      if (payload instanceof Error) throw payload;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: payload }),
      };
    },
  };
}

const PLUS_PLAN = { shop: { plan: { shopifyPlus: true } } };
const NON_PLUS_PLAN = { shop: { plan: { shopifyPlus: false } } };
const GATE_ON = { currentAppInstallation: { id: "gid://shopify/AppInstallation/123", metafield: { value: "true", type: "boolean" } } };
const GATE_OFF = { currentAppInstallation: { id: "gid://shopify/AppInstallation/123", metafield: { value: "false", type: "boolean" } } };

function cartTemplateData(content: string | null) {
  return {
    themes: {
      nodes: [
        {
          id: "gid://shopify/OnlineStoreTheme/1",
          files: {
            nodes: content === null ? [] : [{ body: { content } }],
          },
        },
      ],
    },
  };
}

const ENABLED_CART_TEMPLATE = JSON.stringify({
  sections: {
    apps: {
      type: "apps",
      blocks: {
        consent: { type: `shopify://apps/moda-interact/blocks/cart-consent/${CART_CONSENT_EXTENSION_UID}` },
      },
    },
  },
});

describe("consent placement resolution", () => {
  it("maps the shop plan to exactly one placement", async () => {
    expect(
      await resolveConsentPlacement(adminWith({ ModaConsentShopPlan: PLUS_PLAN })),
    ).toBe("plus_checkout");
    expect(
      await resolveConsentPlacement(adminWith({ ModaConsentShopPlan: NON_PLUS_PLAN })),
    ).toBe("non_plus_cart");
  });

  it("reports unknown instead of guessing when the plan cannot be verified", async () => {
    expect(
      await resolveConsentPlacement(
        adminWith({ ModaConsentShopPlan: new Error("ACCESS_DENIED") }),
      ),
    ).toBe("unknown");
    expect(
      await resolveConsentPlacement(adminWith({ ModaConsentShopPlan: { shop: {} } })),
    ).toBe("unknown");
  });
});

describe("consent activation snapshot", () => {
  const base = { shopDomain: "merchant.myshopify.com", apiKey: "client-id" };

  it("offers only the cart placement with verified published-theme evidence on non-Plus", async () => {
    const activation = await loadConsentActivation({
      ...base,
      admin: adminWith({
        ModaConsentShopPlan: NON_PLUS_PLAN,
        ModaConsentPublishedCartTemplate: cartTemplateData(ENABLED_CART_TEMPLATE),
        ModaConsentCartGate: GATE_ON,
      }),
    });
    expect(activation.placement).toBe("non_plus_cart");
    expect(activation.cartStatus).toBe("active");
    expect(activation.gateState).toBe("enabled");
    expect(activation.plusStatus).toBe("unsupported");
    expect(activation.cartThemeEditorUrl).toContain("/admin/themes/current/editor");
    expect(activation.appProxyDefaultRoot).toBe("/apps/moda-consent");
  });

  it("reports a saved-but-unpublished block as inactive, never active", async () => {
    const activation = await loadConsentActivation({
      ...base,
      admin: adminWith({
        ModaConsentShopPlan: NON_PLUS_PLAN,
        ModaConsentPublishedCartTemplate: cartTemplateData(
          JSON.stringify({ sections: {} }),
        ),
        ModaConsentCartGate: GATE_ON,
      }),
    });
    expect(activation.cartStatus).toBe("inactive");
  });

  it("offers only the checkout placement on Plus and keeps the cart unsupported", async () => {
    const activation = await loadConsentActivation({
      ...base,
      admin: adminWith({ ModaConsentShopPlan: PLUS_PLAN, ModaConsentCartGate: GATE_OFF }),
    });
    expect(activation.placement).toBe("plus_checkout");
    expect(activation.plusStatus).toBe("unverified");
    expect(activation.cartStatus).toBe("unsupported");
    expect(activation.cartThemeEditorUrl).toBeNull();
    expect(activation.checkoutEditorUrl).toContain("/admin/settings/checkout");
  });

  it("degrades to truthful unavailable statuses when evidence reads fail", async () => {
    const activation = await loadConsentActivation({
      ...base,
      admin: adminWith({
        ModaConsentShopPlan: NON_PLUS_PLAN,
        ModaConsentPublishedCartTemplate: new Error("boom"),
        ModaConsentCartGate: GATE_ON,
      }),
    });
    expect(activation.cartStatus).toBe("unavailable");

    const unknown = await loadConsentActivation({
      ...base,
      admin: adminWith({ ModaConsentShopPlan: new Error("boom") }),
    });
    expect(unknown.placement).toBe("unknown");
    expect(unknown.plusStatus).toBe("unavailable");
    expect(unknown.cartStatus).toBe("unverified");
    expect(unknown.cartThemeEditorUrl).toBeNull();
  });
});


describe("merchant-only Shopify cart availability gate", () => {
  it("never reports a published block active when the gate is disabled", async () => {
    const activation = await loadConsentActivation({
      admin: adminWith({ ModaConsentShopPlan: NON_PLUS_PLAN,
        ModaConsentPublishedCartTemplate: cartTemplateData(ENABLED_CART_TEMPLATE),
        ModaConsentCartGate: GATE_OFF }),
      shopDomain: "merchant.myshopify.com", apiKey: "client-id",
    });
    expect(activation.cartStatus).toBe("inactive");
    expect(activation.gateState).toBe("disabled");
  });

  it("sets the app-data gate from a verified app-installation id and verifies Shopify's result", async () => {
    const requests: Array<{ query: string; options?: { variables?: Record<string, unknown> } }> = [];
    const admin: AdminGraphqlClient = {
      async graphql(query, options) {
        requests.push({ query, options });
        const data = query.includes("ModaConsentCartGateSet")
          ? { metafieldsSet: { metafields: [{ value: "true" }], userErrors: [] } }
          : GATE_OFF;
        return { ok: true, status: 200, json: async () => ({ data }) };
      },
    };
    expect(await loadCartConsentGateState(admin)).toBe("disabled");
    expect(await reconcileCartConsentGate(admin, "non_plus_cart")).toBe("enabled");
    expect(requests.at(-1)?.options?.variables).toEqual({
      ownerId: "gid://shopify/AppInstallation/123", value: "true",
    });
  });

  it("disables an old cart gate when a Plus merchant activates checkout", async () => {
    const admin: AdminGraphqlClient = {
      async graphql(query, options) {
        return { ok: true, status: 200, json: async () => ({ data: query.includes("ModaConsentCartGateSet")
          ? { metafieldsSet: { metafields: [{ value: options?.variables?.value }], userErrors: [] } }
          : GATE_ON }) };
      },
    };
    expect(await reconcileCartConsentGate(admin, "plus_checkout")).toBe("disabled");
  });

  it("refuses to reconcile without a verifiable plan", async () => {
    await expect(reconcileCartConsentGate(adminWith({}), "unknown"))
      .rejects.toMatchObject({ code: "SETUP_UNAVAILABLE" });
  });
});
