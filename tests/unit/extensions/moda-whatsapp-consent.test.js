// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

await import("../../../extensions/moda-whatsapp-consent/assets/cart-consent.js");

const RECEIPT = "v1.key.AAAAAAAAAAAAAAAA.eA.AAAAAAAAAAAAAAAAAAAAAA";

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeBlock() {
  document.body.innerHTML = `
    <div
      data-moda-whatsapp-consent
      data-status-url="/apps/moda-consent/cart/status"
      data-receipt-url="/apps/moda-consent/cart/receipt"
      data-verify-url="/apps/moda-consent/cart/verify"
      data-locale="fr-FR"
      hidden
    >
      <input type="checkbox" data-consent-checkbox>
    </div>
  `;
  return document.querySelector("[data-moda-whatsapp-consent]");
}

function cart(token, attributes = {}) {
  return { token, attributes, items: [] };
}

function clickCheckbox(checkbox, checked) {
  checkbox.checked = checked;
  checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
}

beforeEach(() => {
  window.Shopify = { routes: { root: "/fr/" } };
  document.body.innerHTML = "";
});

describe("cart WhatsApp consent block", () => {
  it("shows a new cart unchecked without issuing a receipt", async () => {
    const root = makeBlock();
    const fetcher = vi.fn(async url => {
      if (String(url).endsWith("/fr/cart.js")) return response(cart("new-cart"));
      if (String(url).endsWith("/apps/moda-consent/cart/status")) {
        return response({ checked: false, decision: "NO_CUSTOMER", source: "postgresql" });
      }
      throw new Error("Unexpected request");
    });

    await window.modaWhatsappConsent.initialize(root, fetcher);

    expect(root.hidden).toBe(false);
    expect(root.querySelector("[data-consent-checkbox]").checked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/cart/receipt"))).toBe(false);
  });

  it("displays verified SQL GRANTED without issuing a receipt", async () => {
    const root = makeBlock();
    const fetcher = vi.fn(async url => {
      if (String(url).endsWith("/fr/cart.js")) return response(cart("returning-cart"));
      if (String(url).endsWith("/apps/moda-consent/cart/status")) {
        return response({ checked: true, decision: "GRANTED", source: "postgresql" });
      }
      throw new Error("Unexpected request");
    });

    await window.modaWhatsappConsent.initialize(root, fetcher);

    expect(root.querySelector("[data-consent-checkbox]").checked).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/cart/receipt"))).toBe(false);
  });

  it.each([
    ["GRANT", true],
    ["REVOKE", false],
  ])("renders a verified existing %s receipt without issuing a new receipt", async (decision, checked) => {
    const root = makeBlock();
    const fetcher = vi.fn(async (url, init = {}) => {
      if (String(url).endsWith("/fr/cart.js")) {
        return response(cart("receipt-cart", { moda_wa_consent_v1: RECEIPT }));
      }
      if (String(url).endsWith("/apps/moda-consent/cart/verify")) {
        expect(JSON.parse(init.body)).toEqual({ cartToken: "receipt-cart", receipt: RECEIPT });
        return response({ source: "verified_receipt", decision });
      }
      throw new Error("Unexpected request");
    });

    await window.modaWhatsappConsent.initialize(root, fetcher);

    expect(root.hidden).toBe(false);
    expect(root.querySelector("[data-consent-checkbox]").checked).toBe(checked);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/cart/receipt"))).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/cart/verify"))).toBe(true);
  });

  it("hides the control when a present receipt cannot be verified without falling back to SQL", async () => {
    const root = makeBlock();
    const fetcher = vi.fn(async url => {
      if (String(url).endsWith("/fr/cart.js")) {
        return response(cart("tampered-cart", { moda_wa_consent_v1: RECEIPT }));
      }
      if (String(url).endsWith("/apps/moda-consent/cart/verify")) {
        return response({ error: "INVALID_RECEIPT" }, 400);
      }
      if (String(url).endsWith("/apps/moda-consent/cart/status")) {
        return response({ checked: true, decision: "GRANTED", source: "postgresql" });
      }
      throw new Error("Unexpected request");
    });

    await window.modaWhatsappConsent.initialize(root, fetcher);

    expect(root.hidden).toBe(true);
    expect(root.querySelector("[data-consent-checkbox]").disabled).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/cart/status"))).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/cart/receipt"))).toBe(false);
  });

  it("issues only on an explicit GRANT and confirms the exact receipt without overwriting other attributes", async () => {
    const root = makeBlock();
    let currentCart = cart("current-cart", { gift_note: "keep me" });
    const fetcher = vi.fn(async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith("/fr/cart.js")) return response(currentCart);
      if (path.endsWith("/apps/moda-consent/cart/status")) {
        return response({ checked: false, decision: "NO_CUSTOMER", source: "postgresql" });
      }
      if (path.endsWith("/apps/moda-consent/cart/receipt")) {
        expect(JSON.parse(init.body)).toEqual({
          cartToken: "current-cart",
          decision: "GRANT",
          locale: "fr-FR",
        });
        return response({ receipt: RECEIPT });
      }
      if (path.endsWith("/fr/cart/update.js")) {
        expect(JSON.parse(init.body)).toEqual({
          attributes: { moda_wa_consent_v1: RECEIPT },
        });
        currentCart = cart("current-cart", {
          gift_note: "keep me",
          moda_wa_consent_v1: RECEIPT,
        });
        return response(currentCart);
      }
      throw new Error("Unexpected request");
    });

    await window.modaWhatsappConsent.initialize(root, fetcher);
    const checkbox = root.querySelector("[data-consent-checkbox]");
    clickCheckbox(checkbox, true);
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));

    expect(checkbox.checked).toBe(true);
    expect(currentCart.attributes.gift_note).toBe("keep me");
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/cart/receipt"))).toHaveLength(1);
  });

  it("writes an explicit REVOKE to the same receipt attribute", async () => {
    const root = makeBlock();
    let currentCart = cart("returning-cart");
    const revokeReceipt = "v1.key.AAAAAAAAAAAAAAAA.cmV2b2tl.AAAAAAAAAAAAAAAAAAAAAA";
    const fetcher = vi.fn(async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith("/fr/cart.js")) return response(currentCart);
      if (path.endsWith("/apps/moda-consent/cart/status")) {
        return response({ checked: true, decision: "GRANTED", source: "postgresql" });
      }
      if (path.endsWith("/apps/moda-consent/cart/receipt")) {
        expect(JSON.parse(init.body)).toMatchObject({
          cartToken: "returning-cart",
          decision: "REVOKE",
        });
        return response({ receipt: revokeReceipt });
      }
      if (path.endsWith("/fr/cart/update.js")) {
        expect(JSON.parse(init.body)).toEqual({
          attributes: { moda_wa_consent_v1: revokeReceipt },
        });
        currentCart = cart("returning-cart", { moda_wa_consent_v1: revokeReceipt });
        return response(currentCart);
      }
      throw new Error("Unexpected request");
    });

    await window.modaWhatsappConsent.initialize(root, fetcher);
    const checkbox = root.querySelector("[data-consent-checkbox]");
    expect(checkbox.checked).toBe(true);
    clickCheckbox(checkbox, false);
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));

    expect(checkbox.checked).toBe(false);
    expect(currentCart.attributes.moda_wa_consent_v1).toBe(revokeReceipt);
  });

  it("replaces GRANT with REVOKE on the same cart and reloads the verified latest choice", async () => {
    let currentCart = cart("same-cart");
    const grantReceipt = "v1.key.AAAAAAAAAAAAAAAA.Z3JhbnQ.AAAAAAAAAAAAAAAAAAAAAA";
    const revokeReceipt = "v1.key.AAAAAAAAAAAAAAAA.cmV2b2tl.AAAAAAAAAAAAAAAAAAAAAA";
    const fetcher = vi.fn(async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith("/fr/cart.js")) return response(currentCart);
      if (path.endsWith("/apps/moda-consent/cart/status")) {
        return response({ checked: false, decision: "NO_CUSTOMER", source: "postgresql" });
      }
      if (path.endsWith("/apps/moda-consent/cart/receipt")) {
        const { decision } = JSON.parse(init.body);
        return response({ receipt: decision === "GRANT" ? grantReceipt : revokeReceipt });
      }
      if (path.endsWith("/fr/cart/update.js")) {
        const { attributes } = JSON.parse(init.body);
        expect(Object.keys(attributes)).toEqual(["moda_wa_consent_v1"]);
        currentCart = cart("same-cart", attributes);
        return response(currentCart);
      }
      if (path.endsWith("/apps/moda-consent/cart/verify")) {
        const { cartToken, receipt } = JSON.parse(init.body);
        expect(cartToken).toBe("same-cart");
        expect(receipt).toBe(revokeReceipt);
        return response({ source: "verified_receipt", decision: "REVOKE" });
      }
      throw new Error("Unexpected request");
    });

    const root = makeBlock();
    await window.modaWhatsappConsent.initialize(root, fetcher);
    const checkbox = root.querySelector("[data-consent-checkbox]");
    clickCheckbox(checkbox, true);
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(currentCart.attributes.moda_wa_consent_v1).toBe(grantReceipt);

    clickCheckbox(checkbox, false);
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(currentCart.attributes.moda_wa_consent_v1).toBe(revokeReceipt);

    const reloadedRoot = makeBlock();
    await window.modaWhatsappConsent.initialize(reloadedRoot, fetcher);
    expect(reloadedRoot.querySelector("[data-consent-checkbox]").checked).toBe(false);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/cart/receipt"))).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/cart/verify"))).toHaveLength(1);
  });

  it("binds an explicit choice to the newly read cart and restores the last confirmed state after failed readback", async () => {
    const root = makeBlock();
    let cartReads = 0;
    const fetcher = vi.fn(async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith("/fr/cart.js")) {
        cartReads += 1;
        return response(cartReads === 1
          ? cart("old-cart", { moda_wa_consent_v1: RECEIPT })
          : cart("replacement-cart"));
      }
      if (path.endsWith("/apps/moda-consent/cart/verify")) {
        return response({ source: "verified_receipt", decision: "REVOKE" });
      }
      if (path.endsWith("/apps/moda-consent/cart/receipt")) {
        expect(JSON.parse(init.body)).toMatchObject({
          cartToken: "replacement-cart",
          decision: "GRANT",
        });
        return response({ receipt: RECEIPT });
      }
      if (path.endsWith("/fr/cart/update.js")) return response({}, 500);
      throw new Error("Unexpected request");
    });

    await window.modaWhatsappConsent.initialize(root, fetcher);
    const checkbox = root.querySelector("[data-consent-checkbox]");
    clickCheckbox(checkbox, true);
    await vi.waitFor(() => expect(checkbox.disabled).toBe(false));

    expect(checkbox.checked).toBe(false);
    expect(cartReads).toBe(3);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/cart/receipt"))).toHaveLength(1);
  });

  it("initializes a newly loaded theme editor section once without duplicating existing handlers", async () => {
    const firstRoot = makeBlock();
    const fetcher = vi.fn(async url => {
      if (String(url).endsWith("/fr/cart.js")) return response(cart("section-cart"));
      if (String(url).endsWith("/apps/moda-consent/cart/status")) {
        return response({ checked: false, decision: "NO_CUSTOMER", source: "postgresql" });
      }
      throw new Error("Unexpected request");
    });
    await window.modaWhatsappConsent.initialize(firstRoot, fetcher);
    const callsBeforeSectionLoad = fetcher.mock.calls.length;
    const originalFetch = window.fetch;
    window.fetch = fetcher;

    const section = document.createElement("section");
    section.innerHTML = `
      <div
        data-moda-whatsapp-consent
        data-status-url="/apps/moda-consent/cart/status"
        data-receipt-url="/apps/moda-consent/cart/receipt"
        data-verify-url="/apps/moda-consent/cart/verify"
        data-locale="fr-FR"
        hidden
      >
        <input type="checkbox" data-consent-checkbox>
      </div>
    `;
    document.body.append(section);
    section.dispatchEvent(new window.CustomEvent("shopify:section:load", { bubbles: true }));
    section.dispatchEvent(new window.CustomEvent("shopify:section:load", { bubbles: true }));
    await vi.waitFor(() => {
      expect(section.querySelector("[data-moda-whatsapp-consent]").hidden).toBe(false);
    });
    window.fetch = originalFetch;

    expect(fetcher.mock.calls.length).toBe(callsBeforeSectionLoad + 2);
    expect(firstRoot.querySelector("[data-consent-checkbox]").checked).toBe(false);
  });
});
