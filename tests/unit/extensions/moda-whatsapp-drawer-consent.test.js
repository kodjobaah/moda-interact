// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.resetModules();
  delete window.modaWhatsappDrawerConsent;
  window.modaWhatsappConsent = { initialize: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("requestAnimationFrame", (fn) => setTimeout(fn, 0));
  document.body.innerHTML = `
    <template data-moda-whatsapp-drawer-template>
      <div data-moda-whatsapp-consent data-proxy-root="/apps/moda-consent"
        data-status-url="/apps/moda-consent/cart/status"
        data-receipt-url="/apps/moda-consent/cart/receipt"
        data-verify-url="/apps/moda-consent/cart/verify" data-locale="en" hidden>
        <label><input type="checkbox" data-consent-checkbox>Opt in</label>
      </div>
    </template>`;
});

afterEach(() => {
  window.modaWhatsappDrawerConsent?.destroy();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete window.modaWhatsappConsent;
});

describe("Dawn-style cart drawer adapter", () => {
  it("mounts once before checkout and remounts after the drawer is reopened", async () => {
    const drawer = document.createElement("cart-drawer");
    drawer.innerHTML = `<div id="CartDrawer"><div class="drawer__footer">
      <div class="cart__ctas"><button id="CartDrawer-Checkout">Checkout</button></div>
    </div></div>`;
    document.body.append(drawer);
    await import("../../../extensions/moda-whatsapp-consent/assets/cart-drawer-consent.js");
    await flush();
    expect(drawer.querySelectorAll("[data-moda-whatsapp-drawer-consent]")).toHaveLength(0);
    drawer.classList.add("active");
    await flush();
    expect(drawer.querySelectorAll("[data-moda-whatsapp-drawer-consent]")).toHaveLength(1);
    expect(drawer.querySelector("[data-moda-whatsapp-drawer-consent]")?.nextElementSibling?.className).toBe("cart__ctas");
    expect(window.modaWhatsappConsent.initialize).toHaveBeenCalledTimes(1);
    window.modaWhatsappDrawerConsent.refresh();
    await flush();
    expect(window.modaWhatsappConsent.initialize).toHaveBeenCalledTimes(1);
    drawer.classList.remove("active");
    await flush();
    expect(drawer.querySelectorAll("[data-moda-whatsapp-drawer-consent]")).toHaveLength(0);
    drawer.classList.add("active");
    await flush();
    expect(window.modaWhatsappConsent.initialize).toHaveBeenCalledTimes(2);
  });

  it("does not inject into unsupported drawer markup", async () => {
    const drawer = document.createElement("cart-drawer");
    drawer.classList.add("active");
    drawer.innerHTML = '<div id="CartDrawer"><button id="CartDrawer-Checkout">Checkout</button></div>';
    document.body.append(drawer);
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await import("../../../extensions/moda-whatsapp-consent/assets/cart-drawer-consent.js");
    await flush();
    expect(drawer.querySelector("[data-moda-whatsapp-drawer-consent]")).toBeNull();
    expect(window.modaWhatsappConsent.initialize).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[moda.cart.drawer]", "drawer.unsupported_structure", { stage: "mount" });
    log.mockRestore();
  });
});
