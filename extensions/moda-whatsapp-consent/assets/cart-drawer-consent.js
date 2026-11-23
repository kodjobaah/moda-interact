(() => {
  if (window.modaWhatsappDrawerConsent) return;

  let scheduled = false;
  let counter = 0;
  let lastUnsupported = null;
  const LOG_PREFIX = "[moda.cart.drawer]";

  function isVisibleDrawer(drawer) {
    return drawer instanceof HTMLElement && drawer.classList.contains("active") &&
      drawer.querySelector("#CartDrawer") !== null;
  }

  function mount() {
    scheduled = false;
    const drawer = document.querySelector("cart-drawer");
    const existing = document.querySelectorAll("[data-moda-whatsapp-drawer-consent]");
    const active = isVisibleDrawer(drawer);
    for (const root of existing) {
      if (!active || !drawer.contains(root)) root.remove();
    }
    if (!active) return;
    const footer = drawer.querySelector("#CartDrawer .drawer__footer");
    const checkout = footer?.querySelector("#CartDrawer-Checkout");
    const ctas = checkout?.closest(".cart__ctas");
    if (!footer || !ctas || !footer.contains(ctas)) {
      if (lastUnsupported !== drawer) {
        console.warn(LOG_PREFIX, "drawer.unsupported_structure", { stage: "mount" });
        lastUnsupported = drawer;
      }
      return;
    }
    lastUnsupported = null;
    if (drawer.querySelector("[data-moda-whatsapp-drawer-consent]")) return;
    if (typeof window.modaWhatsappConsent?.initialize !== "function") return;
    const template = document.querySelector("template[data-moda-whatsapp-drawer-template]");
    if (!(template instanceof HTMLTemplateElement)) return;
    const source = template.content.querySelector("[data-moda-whatsapp-consent]");
    if (!(source instanceof HTMLElement)) return;
    const root = source.cloneNode(true);
    if (!(root instanceof HTMLElement)) return;
    counter += 1;
    const checkbox = root.querySelector("[data-consent-checkbox]");
    const label = root.querySelector("label");
    if (!(checkbox instanceof HTMLInputElement) || !(label instanceof HTMLLabelElement)) return;
    const id = `ModaCartDrawerConsentCheckbox-${counter}`;
    checkbox.id = id;
    label.htmlFor = id;
    root.dataset.modaWhatsappDrawerConsent = "";
    ctas.before(root);
    void window.modaWhatsappConsent.initialize(root);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(mount);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "aria-hidden"],
  });
  window.addEventListener("moda:cart-consent-ready", schedule);
  document.addEventListener("shopify:section:load", schedule);
  document.addEventListener("DOMContentLoaded", schedule, { once: true });
  function destroy() {
    observer.disconnect();
    window.removeEventListener("moda:cart-consent-ready", schedule);
    document.removeEventListener("shopify:section:load", schedule);
    document.removeEventListener("DOMContentLoaded", schedule);
  }
  window.modaWhatsappDrawerConsent = Object.freeze({ refresh: schedule, destroy });
  schedule();
})();
