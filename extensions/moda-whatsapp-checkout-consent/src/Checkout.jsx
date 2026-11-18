import '@shopify/ui-extensions/preact';
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";
import {
  canRenderConsent,
  CHECKOUT_RECEIPT_ENDPOINT,
  CONSENT_ATTRIBUTE_KEY,
  isConsentStatus,
  readConsentReceipt,
} from "./consent.js";

export default async () => {
  render(<Extension />, document.body)
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
    if (!canRenderConsent({target, checkoutToken, canUpdateAttributes})) return;

    const currentReceipt = readConsentReceipt(shopify.attributes.value);
    if (currentReceipt === undefined) return;

    async function loadStatus() {
      try {
        const sessionToken = await shopify.sessionToken.get();
        const response = await fetch(
          CHECKOUT_RECEIPT_ENDPOINT,
          {
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
          },
        );
        if (!response.ok) return;
        const result = await response.json();
        if (!isConsentStatus(result) || !active) return;
        setChecked(result.checked);
        setReady(true);
      } catch {
        // Keep the extension silent and hidden when status cannot be verified.
      }
    }

    void loadStatus();
    return () => {
      active = false;
    };
  }, [target, checkoutToken, canUpdateAttributes]);

  if (
    !ready ||
    !canRenderConsent({target, checkoutToken, canUpdateAttributes})
  ) {
    return null;
  }

  async function onCheckboxChange(event) {
    if (saving) return;
    const nextChecked = Boolean(event.target.checked);
    setSaving(true);
    try {
      const sessionToken = await shopify.sessionToken.get();
      const response = await fetch(
        CHECKOUT_RECEIPT_ENDPOINT,
        {
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
        },
      );
      if (!response.ok) return;
      const body = await response.json();
      if (typeof body.receipt !== "string" || body.receipt.length === 0) return;

      const result = await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: CONSENT_ATTRIBUTE_KEY,
        value: body.receipt,
      });
      if (result.type !== "success") return;

      const readback = readConsentReceipt(shopify.attributes.value);
      if (readback === body.receipt) setChecked(nextChecked);
    } catch {
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