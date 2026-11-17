import { describe, expect, it } from "vitest";
import { buildCartConsentThemeActivationUrl } from "../../../app/services/shopify-consent/theme-activation-url.server";
import { getCartConsentThemeActivationStatus } from "../../../app/services/shopify-consent/theme-activation-status.client";

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
