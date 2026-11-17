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

  it("does not interpret an existing cart receipt as a verified grant", async () => {
    const root = makeBlock();
    const fetcher = vi.fn(async url => {
      if (String(url).endsWith("/fr/cart.js")) {
        return response(cart("receipt-cart", { moda_wa_consent_v1: RECEIPT }));
      }
      throw new Error("Unexpected request");
    });

    await window.modaWhatsappConsent.initialize(root, fetcher);

    expect(root.hidden).toBe(false);
    expect(root.querySelector("[data-consent-checkbox]").checked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
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
});
