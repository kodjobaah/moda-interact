(() => {
  if (window.modaWhatsappConsent) return;

  const RECEIPT_ATTRIBUTE = "moda_wa_consent_v1";
  const initializedRoots = new WeakSet();

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function sameOriginUrl(path) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Invalid same-origin path.");
    }

    const url = new URL(path, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid same-origin path.");
    }
    return url.toString();
  }

  function cartUrl() {
    const routesRoot = window.Shopify?.routes?.root;
    if (
      typeof routesRoot !== "string" ||
      !routesRoot.startsWith("/") ||
      routesRoot.startsWith("//")
    ) {
      throw new Error("Shopify locale-aware routes are unavailable.");
    }
    const root = routesRoot.endsWith("/") ? routesRoot : `${routesRoot}/`;
    return sameOriginUrl(`${root}cart.js`);
  }

  async function responseJson(fetcher, url, init) {
    const response = await fetcher(url, init);
    if (!response.ok) throw new Error("Shopify consent request failed.");
    return response.json();
  }

  function readCartShape(value) {
    if (!isObject(value) || typeof value.token !== "string" || !isObject(value.attributes)) {
      throw new Error("Shopify cart data is unavailable.");
    }
    const baseToken = value.token.split("?", 1)[0];
    if (!baseToken) throw new Error("Shopify cart token is unavailable.");
    return { token: value.token, baseToken, attributes: value.attributes };
  }

  function hasCurrentReceipt(attributes) {
    if (!Object.hasOwn(attributes, RECEIPT_ATTRIBUTE)) return false;
    const value = attributes[RECEIPT_ATTRIBUTE];
    return typeof value !== "string" || value.length > 0;
  }

  function isReceipt(value) {
    if (typeof value !== "string" || value.length > 512) return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x21 || code > 0x7e) return false;
    }

    const parts = value.split(".");
    return parts.length === 5 &&
      parts[0] === "v1" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(parts[1]) &&
      parts[2].length === 16 &&
      /^[A-Za-z0-9_-]+$/.test(parts[2]) &&
      /^[A-Za-z0-9_-]+$/.test(parts[3]) &&
      parts[4].length === 22 &&
      /^[A-Za-z0-9_-]+$/.test(parts[4]);
  }

  async function readCart(fetcher) {
    const data = await responseJson(fetcher, cartUrl(), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    return readCartShape(data);
  }

  async function issueReceipt(fetcher, root, cartToken, decision) {
    const locale = root.dataset.locale;
    if (typeof locale !== "string" || locale.length < 2 || locale.length > 35) {
      throw new Error("Shopper locale is unavailable.");
    }
    const data = await responseJson(fetcher, sameOriginUrl(root.dataset.receiptUrl), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cartToken, decision, locale }),
    });
    if (!isObject(data) || !isReceipt(data.receipt)) {
      throw new Error("Shopify consent receipt is unavailable.");
    }
    return data.receipt;
  }

  function matchesReceipt(cart, expectedBaseToken, receipt) {
    return cart.baseToken === expectedBaseToken &&
      cart.attributes[RECEIPT_ATTRIBUTE] === receipt;
  }

  async function updateAndConfirm(fetcher, expectedBaseToken, receipt) {
    let updateError;
    try {
      const updatedCart = readCartShape(await responseJson(
        fetcher,
        cartUrl().replace(/cart\.js$/, "cart/update.js"),
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            attributes: { [RECEIPT_ATTRIBUTE]: receipt },
          }),
        },
      ));
      if (matchesReceipt(updatedCart, expectedBaseToken, receipt)) return;
    } catch (error) {
      updateError = error;
    }

    let readback;
    try {
      readback = await readCart(fetcher);
    } catch (error) {
      throw new Error("Shopify consent receipt could not be confirmed.", { cause: error });
    }
    if (!matchesReceipt(readback, expectedBaseToken, receipt)) {
      throw new Error("Shopify consent receipt could not be confirmed.", { cause: updateError });
    }
  }

  async function readSqlStatus(fetcher, root) {
    const data = await responseJson(fetcher, sameOriginUrl(root.dataset.statusUrl), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const decisions = new Set([
      "GRANTED",
      "REVOKED",
      "UNKNOWN",
      "NO_CUSTOMER",
      "NO_CONTACT",
      "AMBIGUOUS",
      "UNVERIFIED",
    ]);
    if (
      !isObject(data) ||
      typeof data.checked !== "boolean" ||
      typeof data.decision !== "string" ||
      !decisions.has(data.decision) ||
      data.source !== "postgresql"
    ) {
      throw new Error("Shopify consent status is unavailable.");
    }
    return data.checked && data.decision === "GRANTED";
  }

  async function initialize(root, fetcher = window.fetch.bind(window)) {
    if (initializedRoots.has(root)) return;
    initializedRoots.add(root);
    root.hidden = true;

    const checkbox = root.querySelector("[data-consent-checkbox]");
    if (!(checkbox instanceof HTMLInputElement)) return;

    try {
      const cart = await readCart(fetcher);
      const currentReceiptExists = hasCurrentReceipt(cart.attributes);
      const initialChecked = currentReceiptExists
        ? false
        : await readSqlStatus(fetcher, root);

      let lastConfirmed = initialChecked;
      checkbox.checked = initialChecked;
      checkbox.addEventListener("change", async () => {
        const requestedChoice = checkbox.checked;
        checkbox.disabled = true;
        try {
          const currentCart = await readCart(fetcher);
          const receipt = await issueReceipt(
            fetcher,
            root,
            currentCart.token,
            requestedChoice ? "GRANT" : "REVOKE",
          );
          await updateAndConfirm(fetcher, currentCart.baseToken, receipt);
          lastConfirmed = requestedChoice;
        } catch {
          checkbox.checked = lastConfirmed;
        } finally {
          checkbox.disabled = false;
        }
      });
      root.hidden = false;
    } catch {
      root.hidden = true;
      checkbox.checked = false;
      checkbox.disabled = true;
    }
  }

  window.modaWhatsappConsent = Object.freeze({ initialize });
  const initializeBlocks = () => {
    document.querySelectorAll("[data-moda-whatsapp-consent]").forEach(root => {
      void initialize(root);
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeBlocks, { once: true });
  } else {
    initializeBlocks();
  }
})();
