import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  canRenderConsent,
  CHECKOUT_RECEIPT_ENDPOINT,
  CONSENT_ATTRIBUTE_KEY,
  isConsentStatus,
  readConsentReceipt,
} from "./consent.js";

// Checkout workers are isolated from the host page. Log only bounded, redacted
// diagnostics; never include tokens, checkout attributes, or customer details.
const DIAGNOSTIC_PREFIX = "[moda.checkout.consent]";

function diagnostic(level, event, details = {}) {
  console[level](DIAGNOSTIC_PREFIX, event, details);
}

function safeErrorMessage(error) {
  if (!(error instanceof Error)) return "Unknown error";
  return error.message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted-jwt]",
    )
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .slice(0, 240);
}

function reportFetchFailure(operation, status) {
  diagnostic("warn", "consent.request.http_failure", { operation, status });
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const checkoutToken = shopify.checkoutToken.value;
  const canUpdateAttributes =
    shopify.instructions.value.attributes.canUpdateAttributes;
  const target = shopify.extension.target;
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    if (!canRenderConsent({ target, checkoutToken, canUpdateAttributes })) {
      diagnostic("info", "consent.render.gated", {
        targetSupported: target === "purchase.checkout.contact.render-after",
        checkoutTokenAvailable:
          typeof checkoutToken === "string" && checkoutToken.length > 0,
        canUpdateAttributes: canUpdateAttributes === true,
      });
      return;
    }

    const currentReceipt = readConsentReceipt(shopify.attributes.value);
    if (currentReceipt === undefined) {
      diagnostic("warn", "consent.render.receipt_unreadable");
      return;
    }
    diagnostic("info", "consent.status.request_started");

    async function loadStatus() {
      try {
        const sessionToken = await shopify.sessionToken.get();
        const response = await fetch(CHECKOUT_RECEIPT_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "status",
            checkoutToken,
            receipt: currentReceipt,
          }),
        });
        if (!response.ok) {
          reportFetchFailure("status", response.status);
          return;
        }
        const result = await response.json();
        if (!isConsentStatus(result)) {
          diagnostic("warn", "consent.status.invalid_response");
          return;
        }
        if (!active) return;
        setChecked(result.checked);
        setReady(true);
        diagnostic("info", "consent.render.ready", { source: result.source });
      } catch (error) {
        diagnostic("error", "consent.status.exception", {
          message: safeErrorMessage(error),
        });
      }
    }

    void loadStatus();
    return () => {
      active = false;
    };
  }, [target, checkoutToken, canUpdateAttributes]);

  if (
    !ready ||
    !canRenderConsent({ target, checkoutToken, canUpdateAttributes })
  ) {
    return null;
  }

  async function onCheckboxChange(event) {
    if (saving) return;
    const nextChecked = Boolean(event.target.checked);
    setSaving(true);
    try {
      const sessionToken = await shopify.sessionToken.get();
      const response = await fetch(CHECKOUT_RECEIPT_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          checkoutToken,
          decision: nextChecked ? "GRANT" : "REVOKE",
          locale: shopify.localization.language.value.isoCode,
        }),
      });
      if (!response.ok) {
        reportFetchFailure("decision", response.status);
        return;
      }
      const body = await response.json();
      if (typeof body.receipt !== "string" || body.receipt.length === 0) {
        diagnostic("warn", "consent.decision.invalid_receipt");
        return;
      }

      const result = await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: CONSENT_ATTRIBUTE_KEY,
        value: body.receipt,
      });
      if (result.type !== "success") {
        diagnostic("warn", "consent.attribute.update_failed", {
          type: result.type,
        });
        return;
      }

      const readback = readConsentReceipt(shopify.attributes.value);
      if (readback === body.receipt) {
        setChecked(nextChecked);
        diagnostic("info", "consent.decision.confirmed");
      } else {
        diagnostic("warn", "consent.attribute.readback_mismatch");
      }
    } catch (error) {
      diagnostic("error", "consent.decision.exception", {
        message: safeErrorMessage(error),
      });
      // Do not display or persist an unacknowledged choice.
    } finally {
      setSaving(false);
    }
  }

  return (
    <s-checkbox
      checked={checked}
      disabled={saving}
      onChange={onCheckboxChange}
      label={shopify.i18n.translate("consentDisclosure")}
    />
  );
}
