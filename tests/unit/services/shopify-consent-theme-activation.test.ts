import { describe, expect, it } from "vitest";
import { buildCartConsentThemeActivationUrl } from "../../../app/services/shopify-consent/theme-activation-url.server";
import * as activationStatusModule from "../../../app/services/shopify-consent/theme-activation-status";
import { getCartConsentThemeActivationStatus } from "../../../app/services/shopify-consent/theme-activation-status";

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

  it("rejects malformed shop domains and API keys", () => {
    expect(() => buildCartConsentThemeActivationUrl({
      shopDomain: "merchant.example",
      apiKey: "client-id",
      placement: "non_plus_cart",
    })).toThrow(TypeError);
    expect(() => buildCartConsentThemeActivationUrl({
      shopDomain: "merchant.myshopify.com",
      apiKey: "client-id/other-shop",
      placement: "non_plus_cart",
    })).toThrow(TypeError);
  });
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

  it("reports an unsupported cart when the template is missing or not JSON", () => {
    expect(deriveCartTemplateEvidence(null)).toEqual({
      cartTemplateSupported: false,
      blockEnabledInPublishedTheme: null,
    });
    expect(deriveCartTemplateEvidence("{% raw liquid %}")).toEqual({
      cartTemplateSupported: false,
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
              type: "shopify://apps/moda-interact/blocks/cart-consent/0000",
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
              type: "shopify://apps/moda-interact/blocks/cart-consent/0000",
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
