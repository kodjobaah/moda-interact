import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WhatsAppCustomerConsent, {
  type WhatsAppConsentActivation,
} from "@/routes/app/recovery-settings/WhatsAppCustomerConsent";

const t = (key: string) => key;

function render(activation: WhatsAppConsentActivation) {
  return renderToStaticMarkup(
    <WhatsAppCustomerConsent t={t} activation={activation} onActivate={() => undefined} />,
  );
}

const base = {
  gateState: "disabled" as const,
  appProxyDefaultRoot: "/apps/moda-consent",
};

describe("Shopify merchant consent activation", () => {
  it("offers exactly one cart activation on non-Plus, no Plus action or technical proxy card", () => {
    const html = render({
      ...base,
      placement: "non_plus_cart",
      cartStatus: "inactive",
      plusStatus: "unsupported",
      cartThemeEditorUrl: "https://merchant.myshopify.com/admin/themes/current/editor?template=cart",
      checkoutEditorUrl: null,
    });
    expect(html).toContain('data-consent-card="cart-block"');
    expect(html).toContain('data-activation-status="inactive"');
    expect(html).toContain("recoverySettings.whatsappConsent.activationAction");
    expect((html.match(/activationAction/g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-consent-card="plus-checkout"');
    expect(html).not.toContain('data-consent-card="app-proxy"');
  });

  it("offers only checkout activation to Plus merchants and no cart workflow", () => {
    const html = render({
      ...base,
      placement: "plus_checkout",
      cartStatus: "unsupported",
      plusStatus: "unverified",
      cartThemeEditorUrl: null,
      checkoutEditorUrl: "https://merchant.myshopify.com/admin/settings/checkout",
    });
    expect(html).toContain('data-consent-card="plus-checkout"');
    expect(html).toContain("recoverySettings.whatsappConsent.activationAction");
    expect(html).not.toContain('data-consent-card="cart-block"');
    expect(html).not.toContain('data-consent-card="app-proxy"');
  });

  it("offers neither activation when plan evidence is unknown", () => {
    const html = render({
      ...base,
      placement: "unknown",
      cartStatus: "unverified",
      plusStatus: "unavailable",
      cartThemeEditorUrl: null,
      checkoutEditorUrl: null,
      gateState: "unknown",
    });
    expect(html).toContain('data-consent-card="unknown-plan"');
    expect(html).not.toContain("recoverySettings.whatsappConsent.activationAction");
    expect(html).not.toContain('data-consent-card="cart-block"');
    expect(html).not.toContain('data-consent-card="plus-checkout"');
  });

  it("shows verified active status without another activation action", () => {
    const html = render({
      ...base, gateState: "enabled",
      placement: "non_plus_cart",
      cartStatus: "active",
      plusStatus: "unsupported",
      cartThemeEditorUrl: "https://merchant.myshopify.com/admin/themes/current/editor",
      checkoutEditorUrl: null,
    });
    expect(html).toContain('data-activation-status="active"');
    expect(html).not.toContain("recoverySettings.whatsappConsent.activationAction");
    expect(html).toContain("recoverySettings.whatsappConsent.returning");
    expect(html).toContain("recoverySettings.whatsappConsent.stop");
  });
});
