import { describe, expect, it } from "vitest";
import { buildCartConsentThemeActivationUrl, buildCartConsentThemeEditorUrl } from "../../../app/services/shopify-consent/theme-activation-url.server";
import * as activationStatusModule from "../../../app/services/shopify-consent/theme-activation-status";
import { getCartConsentThemeActivationStatus } from "../../../app/services/shopify-consent/theme-activation-status";

// Actual type suffix returned in Shopify's published templates/cart.json.
// It differs from shopify.extension.toml's development configuration UID.
const SHOPIFY_PUBLISHED_CART_BLOCK_ID = "01a1f174-b1a4-78bf-b843-c2cd7385513c";

describe("cart consent theme activation URL", () => {
  it("creates the cart template editor link only for non-Plus placement", () => {
    const url = buildCartConsentThemeActivationUrl({
      shopDomain: "merchant.myshopify.com",
      apiKey: "client-id",
      placement: "non_plus_cart",
    });

    expect(url).not.toBeNull();
    if (!url) throw new Error("Expected a cart activation URL.");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://merchant.myshopify.com");
    expect(parsed.pathname).toBe("/admin/themes/current/editor");
    expect(parsed.searchParams.get("template")).toBe("cart");
    expect(parsed.searchParams.get("addAppBlockId")).toBe("client-id/cart-consent");
    expect(parsed.searchParams.get("target")).toBe("newAppsSection");
  });

  it("uses a safe editor URL without an automatic block insertion for resume or restore", () => {
    const url = buildCartConsentThemeEditorUrl({
      shopDomain: "merchant.myshopify.com", placement: "non_plus_cart",
    });
    expect(url).toBe("https://merchant.myshopify.com/admin/themes/current/editor?template=cart");
    expect(url).not.toContain("addAppBlockId");
  });

  it.each(["plus_checkout", "unknown"] as const)(
    "does not offer cart activation for %s placement",
    placement => {
      expect(buildCartConsentThemeActivationUrl({
        shopDomain: "merchant.myshopify.com",
        apiKey: "client-id",
        placement,
      })).toBeNull();
    },
  );
});

describe("cart consent theme activation status", () => {
  const verifiedEvidence = {
    placement: "non_plus_cart" as const,
    publishedThemeAvailable: true,
    cartTemplateSupported: true,
  };

  it("reports active or inactive only from complete published-theme evidence", () => {
    expect(getCartConsentThemeActivationStatus({
      ...verifiedEvidence,
      blockEnabledInPublishedTheme: true,
    })).toBe("active");
    expect(getCartConsentThemeActivationStatus({
      ...verifiedEvidence,
      blockEnabledInPublishedTheme: false,
    })).toBe("inactive");
  });

  it("fails closed for Plus, unavailable themes, unsupported templates and missing evidence", () => {
    expect(getCartConsentThemeActivationStatus({
      ...verifiedEvidence,
      placement: "plus_checkout",
      blockEnabledInPublishedTheme: true,
    })).toBe("unsupported");
    expect(getCartConsentThemeActivationStatus({
      ...verifiedEvidence,
      publishedThemeAvailable: false,
      blockEnabledInPublishedTheme: false,
    })).toBe("unavailable");
    expect(getCartConsentThemeActivationStatus({
      ...verifiedEvidence,
      cartTemplateSupported: false,
      blockEnabledInPublishedTheme: false,
    })).toBe("unsupported");
    expect(getCartConsentThemeActivationStatus({
      placement: "unknown",
      publishedThemeAvailable: null,
      cartTemplateSupported: null,
      blockEnabledInPublishedTheme: null,
    })).toBe("unverified");
  });
});

describe("plus checkout consent activation status", () => {
  it("is exclusive per plan and truthful without verification evidence", () => {
    const { getPlusCheckoutConsentActivationStatus } = activationStatusModule;
    expect(getPlusCheckoutConsentActivationStatus({
      placement: "non_plus_cart",
      extensionVerified: null,
    })).toBe("unsupported");
    expect(getPlusCheckoutConsentActivationStatus({
      placement: "unknown",
      extensionVerified: null,
    })).toBe("unavailable");
    expect(getPlusCheckoutConsentActivationStatus({
      placement: "plus_checkout",
      extensionVerified: null,
    })).toBe("unverified");
    expect(getPlusCheckoutConsentActivationStatus({
      placement: "plus_checkout",
      extensionVerified: true,
    })).toBe("active");
  });
});

describe("published cart template evidence", () => {
  const { deriveCartTemplateEvidence } = activationStatusModule;

  it("treats missing or malformed template evidence as unverified, not unsupported", () => {
    expect(deriveCartTemplateEvidence(null)).toEqual({
      cartTemplateSupported: null,
      blockEnabledInPublishedTheme: null,
    });
    expect(deriveCartTemplateEvidence("{% raw liquid %}")).toEqual({
      cartTemplateSupported: null,
      blockEnabledInPublishedTheme: null,
    });
    expect(deriveCartTemplateEvidence(JSON.stringify({ unexpected: true }))).toEqual({
      cartTemplateSupported: null,
      blockEnabledInPublishedTheme: null,
    });
  });

  it("finds the enabled cart-consent app block anywhere in the template", () => {
    const template = JSON.stringify({
      sections: {
        main: { type: "main-cart-items" },
        apps: {
          type: "apps",
          blocks: {
            consent: {
              type: `shopify://apps/moda-interact/blocks/cart-consent/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}`,
            },
          },
        },
      },
    });
    expect(deriveCartTemplateEvidence(template)).toEqual({
      cartTemplateSupported: true,
      blockEnabledInPublishedTheme: true,
    });
  });

  it("treats a disabled or absent block as saved-but-not-active", () => {
    const disabled = JSON.stringify({
      sections: {
        apps: {
          type: "apps",
          blocks: {
            consent: {
              type: `shopify://apps/moda-interact/blocks/cart-consent/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}`,
              disabled: true,
            },
          },
        },
      },
    });
    expect(deriveCartTemplateEvidence(disabled)).toEqual({
      cartTemplateSupported: true,
      blockEnabledInPublishedTheme: false,
    });
    expect(deriveCartTemplateEvidence(JSON.stringify({ sections: {} }))).toEqual({
      cartTemplateSupported: true,
      blockEnabledInPublishedTheme: false,
    });
  });
});

describe("published cart block presence", () => {
  const { inspectCartConsentBlockPresence } = activationStatusModule;
  const block = { type: `shopify://apps/moda-interact/blocks/cart-consent/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}` };
  const template = (blocks: Record<string, unknown>, disabled = false) => JSON.stringify({
    sections: { apps: { type: "apps", disabled, blocks } },
  });

  it("recognises the exact published Moda block from Shopify's MAIN cart template", () => {
    const content = `/* Shopify generated header */\n${JSON.stringify({
      sections: {
        "cart-items": { type: "main-cart-items" },
        "1795112986549ca2a8": {
          type: "apps",
          blocks: {
            moda_interact_cart_consent_BYfR7p: {
              type: `shopify://apps/moda-interact/blocks/cart-consent/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}`,
              settings: { app_proxy_root: "/apps/moda-consent" },
            },
          },
          block_order: ["moda_interact_cart_consent_BYfR7p"],
        },
      },
      order: ["cart-items", "1795112986549ca2a8"],
    })}`;
    expect(activationStatusModule.inspectCartConsentTemplate(content)).toMatchObject({
      presence: "enabled", outcome: "parsed", generatedHeader: true,
      matchingBlocks: 1, candidateBlocks: 1,
    });
  });

  it("does not accept a lookalike app name, block handle or malformed identifier", () => {
    for (const type of [
      `shopify://apps/another-app/blocks/cart-consent/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}`,
      `shopify://apps/moda-interact-other/blocks/cart-consent/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}`,
      `shopify://apps/moda-interact/blocks/cart-consent-other/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}`,
      `prefix-shopify://apps/moda-interact/blocks/cart-consent/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}`,
      `shopify://apps/moda-interact/blocks/cart-consent/${SHOPIFY_PUBLISHED_CART_BLOCK_ID}/extra`,
      "shopify://apps/moda-interact/blocks/cart-consent/",
    ]) {
      expect(inspectCartConsentBlockPresence(template({ impostor: { type } }))).toBe("absent");
    }
  });

  it("verifies Shopify JSON templates with autogenerated comment headers", () => {
    const header = `/*
     * ------------------------------------------------------------
     * IMPORTANT: The contents of this file are auto-generated.
     * This file may be updated by the Shopify admin theme editor.
     * ------------------------------------------------------------
     */\n`;
    const content = `${header}${template({ consent: block })}`;
    expect(inspectCartConsentBlockPresence(content)).toBe("enabled");
    expect(activationStatusModule.inspectCartConsentTemplate(content)).toMatchObject({
      presence: "enabled", outcome: "parsed", generatedHeader: true,
      matchingBlocks: 1, candidateBlocks: 1,
    });
    expect(activationStatusModule.deriveCartTemplateEvidence(content)).toEqual({
      cartTemplateSupported: true, blockEnabledInPublishedTheme: true,
    });
    expect(inspectCartConsentBlockPresence(`${header}${template({ consent: { ...block, disabled: true } })}`))
      .toBe("disabled");
    expect(inspectCartConsentBlockPresence(`${header}${template({ a: block, b: block })}`))
      .toBe("duplicate");
  });

  it("does not infer presence from malformed headers, malformed JSON or another app", () => {
    expect(activationStatusModule.inspectCartConsentTemplate("/* unclosed")).toMatchObject({
      presence: "unknown", outcome: "unterminated_header",
    });
    expect(activationStatusModule.inspectCartConsentTemplate("/* header */ invalid")).toMatchObject({
      presence: "unknown", outcome: "invalid_json",
    });
    expect(activationStatusModule.inspectCartConsentTemplate(template({ other: {
      type: "shopify://apps/another/blocks/cart-consent/other-id",
    } }))).toMatchObject({
      presence: "absent", outcome: "parsed", matchingBlocks: 0, candidateBlocks: 1,
    });
    const embeddedComment = template({ consent: { ...block, settings: { text: "/* do not alter */" } } });
    expect(inspectCartConsentBlockPresence(embeddedComment)).toBe("enabled");
  });

  it("distinguishes never added, saved but disabled, enabled, and duplicates", () => {
    expect(inspectCartConsentBlockPresence(template({}))).toBe("absent");
    expect(inspectCartConsentBlockPresence(template({ consent: { ...block, disabled: true } })))
      .toBe("disabled");
    expect(inspectCartConsentBlockPresence(template({ consent: block }, true)))
      .toBe("disabled");
    expect(inspectCartConsentBlockPresence(template({ consent: block }))).toBe("enabled");
    expect(inspectCartConsentBlockPresence(template({ a: block, b: block })))
      .toBe("duplicate");
  });

  it("never treats missing templates, malformed JSON or another app as a verified Moda block", () => {
    expect(inspectCartConsentBlockPresence(null)).toBe("unknown");
    expect(inspectCartConsentBlockPresence("not-json")).toBe("unknown");
    expect(inspectCartConsentBlockPresence(JSON.stringify({ unexpected: true }))).toBe("unknown");
    expect(inspectCartConsentBlockPresence(template({ other: {
      type: "shopify://apps/another/blocks/cart-consent/other-id",
    } }))).toBe("absent");
  });
});

describe("published Plus checkout extension evidence", () => {
  const { matchPlusCheckoutExtensionEvidence } = activationStatusModule;
  it("recognises only the matching contact-target checkout UI extension", () => {
    expect(matchPlusCheckoutExtensionEvidence([
      { handle: "moda-whatsapp-checkout-consent", type: "ui_extension",
        activations: [{ target: "purchase.checkout.contact.render-after" }] },
    ])).toBe("active");
    expect(matchPlusCheckoutExtensionEvidence([
      { handle: "some-other-extension", type: "ui_extension",
        activations: [{ target: "purchase.checkout.contact.render-after" }] },
    ])).toBe("inactive");
    expect(matchPlusCheckoutExtensionEvidence([
      { handle: "moda-whatsapp-checkout-consent", type: "ui_extension",
        activations: [{ target: "purchase.thank-you.block.render" }] },
    ])).toBe("unverified");
    expect(matchPlusCheckoutExtensionEvidence([
      { handle: "moda-whatsapp-checkout-consent", type: "ui_extension",
        activations: [{ target: "purchase.checkout.contact.render-after", draft: true }] },
    ])).toBe("unverified");
  });
});
