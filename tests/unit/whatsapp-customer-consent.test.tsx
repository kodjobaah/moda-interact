import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WhatsAppCustomerConsent, {
  type WhatsAppConsentActivation,
} from "@/routes/app/recovery-settings/WhatsAppCustomerConsent";

const t = (key: string) => key;

function render(activation: WhatsAppConsentActivation) {
  return renderToStaticMarkup(
    <WhatsAppCustomerConsent t={t} activation={activation} />,
  );
}

describe("WhatsApp customer consent merchant panel", () => {
  it("shows only the cart placement, proxy guidance and truthful status on non-Plus", () => {
    const html = render({
      placement: "non_plus_cart",
      cartStatus: "inactive",
      plusStatus: "unsupported",
      cartThemeEditorUrl:
        "https://merchant.myshopify.com/admin/themes/current/editor?template=cart",
      appProxyDefaultRoot: "/apps/moda-consent",
    });
    expect(html).toContain('data-consent-card="cart-block"');
    expect(html).toContain('data-consent-card="app-proxy"');
    expect(html).toContain("/apps/moda-consent");
    expect(html).toContain('data-activation-status="inactive"');
    expect(html).toContain("recoverySettings.whatsappConsent.statusInactive");
    expect(html).toContain("admin/themes/current/editor");
    expect(html).not.toContain('data-consent-card="plus-checkout"');
  });

  it("shows only the checkout placement on Plus with an unverified badge", () => {
    const html = render({
      placement: "plus_checkout",
      cartStatus: "unsupported",
      plusStatus: "unverified",
      cartThemeEditorUrl: null,
      appProxyDefaultRoot: "/apps/moda-consent",
    });
    expect(html).toContain('data-consent-card="plus-checkout"');
    expect(html).toContain("recoverySettings.whatsappConsent.statusUnverified");
    expect(html).not.toContain('data-consent-card="cart-block"');
    expect(html).not.toContain('data-consent-card="app-proxy"');
  });

  it("offers neither activation and reports unavailable on an unverified plan", () => {
    const html = render({
      placement: "unknown",
      cartStatus: "unverified",
      plusStatus: "unavailable",
      cartThemeEditorUrl: null,
      appProxyDefaultRoot: "/apps/moda-consent",
    });
    expect(html).toContain('data-consent-card="unknown-plan"');
    expect(html).toContain("recoverySettings.whatsappConsent.statusUnavailable");
    expect(html).not.toContain('data-consent-card="cart-block"');
    expect(html).not.toContain('data-consent-card="plus-checkout"');
  });

  it("keeps Moda-owned returning-customer and STOP guidance without Shopify-native opt-in links", () => {
    const html = render({
      placement: "non_plus_cart",
      cartStatus: "active",
      plusStatus: "unsupported",
      cartThemeEditorUrl: null,
      appProxyDefaultRoot: "/apps/moda-consent",
    });
    expect(html).toContain("recoverySettings.whatsappConsent.returning");
    expect(html).toContain("recoverySettings.whatsappConsent.stop");
    expect(html).not.toContain("help.shopify.com");
  });
});
