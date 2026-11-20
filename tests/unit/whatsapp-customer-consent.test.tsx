import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WhatsAppCustomerConsent, {
  getCartPrimaryAction, type WhatsAppConsentActivation,
} from "@/routes/app/recovery-settings/WhatsAppCustomerConsent";

const t = (key: string) => key;
const cartBase: WhatsAppConsentActivation = {
  placement: "non_plus_cart", cartStatus: "unverified", cartBlockPresence: "unknown",
  plusStatus: "unsupported", gateState: "disabled", setupPhase: "never",
  cartThemeEditorUrl: "https://merchant.myshopify.com/admin/themes/current/editor?template=cart",
  checkoutEditorUrl: null, appProxyDefaultRoot: "/apps/moda-consent",
};
const render = (activation: WhatsAppConsentActivation, props: { busy?: boolean; preparing?: boolean; actionFailed?: boolean } = {}) =>
  renderToStaticMarkup(<WhatsAppCustomerConsent t={t} activation={activation} onActivate={() => undefined} {...props} />);

describe("single-action Shopify merchant consent activation", () => {
  it("offers one initial action even if Shopify cannot read the published theme", () => {
    const html = render(cartBase);
    expect(html).toContain("recoverySettings.whatsappConsent.activationAction");
    expect((html.match(/class=\"moda-recovery-consent-action\"/g) ?? []).length).toBe(1);
    expect(html).not.toContain("activationRecheck");
    expect(html).not.toContain("activationManualAdd");
  });

  it("resumes an abandoned launch without adding another block", () => {
    const activation = { ...cartBase, gateState: "enabled" as const, setupPhase: "started" as const };
    const html = render(activation);
    expect(getCartPrimaryAction(activation)).toEqual({ key: "activationContinue", needsPreparation: false });
    expect(html).toContain('href="https://merchant.myshopify.com/admin/themes/current/editor?template=cart"');
    expect(html).not.toContain("addAppBlockId");
  });

  it("supports a legacy gate-enabled store when the published cart is proven empty", () => {
    const legacy = { ...cartBase, gateState: "enabled" as const,
      cartBlockPresence: "absent" as const };
    expect(getCartPrimaryAction(legacy)).toEqual({
      key: "activationAction", needsPreparation: true,
    });
  });

  it("a verified active placement uses active copy and is managed without inserting blocks", () => {
    const activation = { ...cartBase, gateState: "enabled" as const, setupPhase: "active" as const,
      cartStatus: "active" as const, cartBlockPresence: "enabled" as const };
    expect(getCartPrimaryAction(activation).key).toBe("activationManage");
    const html = render(activation);
    expect(html).toContain("recoverySettings.whatsappConsent.activationManage");
    expect(html).toContain("recoverySettings.whatsappConsent.cartActiveTitle");
    expect(html).toContain("recoverySettings.whatsappConsent.cartActiveBody");
    expect(html).not.toContain("recoverySettings.whatsappConsent.cartTitle");
    expect(html).not.toContain("recoverySettings.whatsappConsent.cartBody");
  });

  it("keeps setup instructions until the published cart is verified active", () => {
    const html = render({ ...cartBase, gateState: "enabled", setupPhase: "started",
      cartStatus: "unverified", cartBlockPresence: "unknown" });
    expect(html).toContain("recoverySettings.whatsappConsent.cartTitle");
    expect(html).toContain("recoverySettings.whatsappConsent.cartBody");
    expect(html).not.toContain("recoverySettings.whatsappConsent.cartActiveTitle");
  });

  it("only verified removed blocks with previous active history offer one-click restore", () => {
    const removed = { ...cartBase, gateState: "enabled" as const, setupPhase: "active" as const,
      cartStatus: "inactive" as const, cartBlockPresence: "absent" as const };
    expect(getCartPrimaryAction(removed)).toEqual({ key: "activationRestore", needsPreparation: true });
    expect(render(removed)).toContain("recoverySettings.whatsappConsent.activationRestore");
    const restoring = { ...removed, setupPhase: "restoring" as const };
    expect(getCartPrimaryAction(restoring).needsPreparation).toBe(false);
  });

  it("manages disabled, duplicate, and unknown placements without automatic insertion", () => {
    for (const [presence, action] of [
      ["disabled", "activationEnable"], ["duplicate", "activationResolveDuplicates"],
      ["unknown", "activationContinue"],
    ] as const) {
      const activation = { ...cartBase, setupPhase: "started" as const, gateState: "enabled" as const,
        cartBlockPresence: presence };
      expect(getCartPrimaryAction(activation)).toEqual({ key: action, needsPreparation: false });
    }
  });

  it("shows one busy primary action and no duplicate buttons", () => {
    const html = render(cartBase, { busy: true, preparing: true });
    expect(html).toContain("activationPreparing");
    expect(html).toContain('aria-busy="true"');
    expect((html.match(/class=\"moda-recovery-consent-action\"/g) ?? []).length).toBe(1);
  });

  it("reports failure without pretending activation succeeded", () => {
    const html = render(cartBase, { actionFailed: true });
    expect(html).toContain("activationFailed");
    expect(html).not.toContain('data-activation-status="active"');
  });

  it("shows the configured proxy path after the translated default-path guidance", () => {
    const html = render(cartBase);
    expect(html).toContain("recoverySettings.whatsappConsent.proxyBody");
    expect(html).toContain("<code>/apps/moda-consent</code>");
  });

  it("retains the plan-exclusive Plus checkout placement", () => {
    const html = render({ ...cartBase, placement: "plus_checkout", plusStatus: "unverified",
      checkoutEditorUrl: "https://merchant.myshopify.com/admin/settings/checkout" });
    expect(html).toContain('data-consent-card="plus-checkout"');
    expect(html).not.toContain('data-consent-card="cart-block"');
  });
});


describe("non-Plus cart drawer setup", () => {
  const enabledCart = { ...cartBase, cartStatus: "active" as const,
    cartBlockPresence: "enabled" as const, setupPhase: "active" as const,
    gateState: "enabled" as const,
    drawerThemeActivationUrl: "https://merchant.myshopify.com/admin/themes/current/editor?context=apps&template=cart&activateAppId=client-id%2Fcart-drawer-consent",
  };
  it("offers one drawer enable link after the cart page is active", () => {
    const html = render(enabledCart);
    expect(html).toContain("recoverySettings.whatsappConsent.drawerTitle");
    expect(html).toContain("recoverySettings.whatsappConsent.drawerEnable");
    expect(html).toContain("activateAppId=");
  });
  it("uses the same button style for both editor navigation links", () => {
    const html = renderToStaticMarkup(<WhatsAppCustomerConsent
      t={t} activation={enabledCart} drawerStatus="active" />);
    expect(html).toContain("data-consent-drawer-activation");
    expect((html.match(/class="moda-recovery-consent-action"/g) ?? []).length).toBe(2);
    expect(html).not.toContain("moda-recovery-consent-action--secondary");
    expect(html).toContain('href="https://merchant.myshopify.com/admin/themes/current/editor?template=cart"');
    expect(html).toContain("recoverySettings.whatsappConsent.drawerManage");
    expect(html).not.toContain("activateAppId=");
  });
  it("keeps the same button style before enabling the drawer", () => {
    const html = render(enabledCart);
    expect((html.match(/class="moda-recovery-consent-action"/g) ?? []).length).toBe(2);
    expect(html).not.toContain("moda-recovery-consent-action--secondary");
    expect(html).toContain("recoverySettings.whatsappConsent.drawerEnable");
    expect(html).toContain("activateAppId=");
  });
  it("does not present drawer activation on Plus or before cart activation", () => {
    expect(render({ ...enabledCart, cartStatus: "unverified" })).not.toContain("drawerEnable");
    expect(render({ ...enabledCart, placement: "plus_checkout" })).not.toContain("drawerEnable");
  });
});
