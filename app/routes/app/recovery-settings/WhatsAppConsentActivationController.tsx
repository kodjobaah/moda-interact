import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { matchPlusCheckoutExtensionEvidence, type ThemeActivationStatus } from
  "@/services/shopify-consent/theme-activation-status";
import WhatsAppCustomerConsent, { type WhatsAppConsentActivation } from "./WhatsAppCustomerConsent";

type Translate = (key: string) => string;

type ActivationResult =
  | { ok: true; placement: "non_plus_cart" | "plus_checkout"; editorUrl: string }
  | { ok: false; error: "SETUP_UNAVAILABLE" | "INVALID_INPUT" };

type AppBridgeExtensionReader = {
  shopify?: { app?: { extensions?: () => Promise<unknown> } };
};

/** One plan-specific activation action; no client-controlled plan or SQL writes. */
export default function WhatsAppConsentActivationController({ t, activation }: {
  t: Translate;
  activation: WhatsAppConsentActivation;
}) {
  const fetcher = useFetcher<ActivationResult>();
  const { revalidate } = useRevalidator();
  const pendingTab = useRef<Window | null>(null);
  const handledResponse = useRef<ActivationResult | null>(null);
  const [plusStatus, setPlusStatus] = useState<ThemeActivationStatus>(activation.plusStatus);
  const [actionFailed, setActionFailed] = useState(false);
  const [editorFallbackUrl, setEditorFallbackUrl] = useState<string | null>(null);

  const verifyPlus = useCallback(async () => {
    if (activation.placement !== "plus_checkout") return;
    const app = (window as unknown as AppBridgeExtensionReader).shopify?.app;
    if (typeof app?.extensions !== "function") {
      setPlusStatus("unverified");
      return;
    }
    try {
      const result = matchPlusCheckoutExtensionEvidence(await app.extensions());
      // If an old Plus cart gate is enabled, we cannot report one exclusive
      // activation until the merchant's explicit setup action disables it.
      setPlusStatus(result === "active" && activation.gateState !== "disabled"
        ? "unverified" : result);
    } catch {
      setPlusStatus("unverified");
    }
  }, [activation.placement, activation.gateState]);

  useEffect(() => { void verifyPlus(); }, [verifyPlus]);

  // When the merchant returns from the Shopify editor, refresh the published
  // theme/gate snapshot and checkout activation evidence. No writes on focus.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void revalidate();
      void verifyPlus();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [revalidate, verifyPlus]);

  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || handledResponse.current === result) return;
    handledResponse.current = result;
    if (!result.ok || result.placement !== activation.placement) {
      pendingTab.current?.close();
      pendingTab.current = null;
      setActionFailed(true);
      return;
    }
    setActionFailed(false);
    if (pendingTab.current && !pendingTab.current.closed) {
      pendingTab.current.location.replace(result.editorUrl);
      pendingTab.current = null;
    } else {
      // Popup blocked: keep a real click-through destination, never lose setup.
      setEditorFallbackUrl(result.editorUrl);
    }
    void revalidate();
  }, [fetcher.data, fetcher.state, activation.placement, revalidate]);

  const activate = () => {
    if (fetcher.state !== "idle") return;
    setActionFailed(false);
    setEditorFallbackUrl(null);
    handledResponse.current = null;
    // Open synchronously from the click to avoid popup blockers after POST.
    pendingTab.current = window.open("about:blank", "_blank");
    fetcher.submit({ intent: "activate" }, {
      method: "post",
      action: "/app/consent-activate",
    });
  };

  return <WhatsAppCustomerConsent t={t} activation={activation}
    plusStatusOverride={activation.placement === "plus_checkout" ? plusStatus : undefined}
    onActivate={activate}
    busy={fetcher.state !== "idle"}
    actionFailed={actionFailed}
    editorFallbackUrl={editorFallbackUrl}
  />;
}
