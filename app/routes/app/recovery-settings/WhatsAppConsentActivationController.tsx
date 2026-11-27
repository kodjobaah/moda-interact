import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import {
  matchPlusCheckoutExtensionEvidence,
  matchCartDrawerEmbedEvidence,
  type ThemeActivationStatus,
} from "@/services/shopify-consent/theme-activation-status";
import WhatsAppCustomerConsent, {
  type WhatsAppConsentActivation,
} from "./WhatsAppCustomerConsent";

type Translate = (key: string) => string;
type ActivationResult =
  | {
      ok: true;
      placement: "non_plus_cart" | "plus_checkout";
      editorUrl: string;
    }
  | { ok: false; error: "SETUP_UNAVAILABLE" | "INVALID_INPUT" };
type VerificationResult =
  | {
      ok: true;
      placement: "non_plus_cart" | "plus_checkout";
      status: ThemeActivationStatus;
    }
  | { ok: false; error: "SETUP_UNAVAILABLE" | "INVALID_INPUT" };
type AppBridgeExtensionReader = {
  shopify?: { app?: { extensions?: () => Promise<unknown> } };
};

/** Owns the entire merchant setup lifecycle; Recovery Settings only renders it. */
export default function WhatsAppConsentActivationController({
  t,
  activation,
}: {
  t: Translate;
  activation: WhatsAppConsentActivation;
}) {
  const activationFetcher = useFetcher<ActivationResult>();
  const verificationFetcher = useFetcher<VerificationResult>();
  const { revalidate } = useRevalidator();
  const pendingTab = useRef<Window | null>(null);
  const handledActivation = useRef<ActivationResult | null>(null);
  const handledVerification = useRef<VerificationResult | null>(null);
  const activationSubmitted = useRef(false);
  const activationRequestPending = useRef(false);
  const checkInFlight = useRef(false);
  const autoCheckedPhase = useRef<string | null>(null);
  const [plusStatus, setPlusStatus] = useState<ThemeActivationStatus>(
    activation.plusStatus,
  );
  const [drawerStatus, setDrawerStatus] = useState<
    "active" | "inactive" | "unverified"
  >("unverified");
  const [actionFailed, setActionFailed] = useState(false);
  const [activationPending, setActivationPending] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [editorFallbackUrl, setEditorFallbackUrl] = useState<string | null>(
    null,
  );

  const verifyPlus = useCallback(async () => {
    if (activation.placement !== "plus_checkout") return;
    const app = (window as unknown as AppBridgeExtensionReader).shopify?.app;
    if (typeof app?.extensions !== "function") {
      setPlusStatus("unverified");
      return;
    }
    try {
      const result = matchPlusCheckoutExtensionEvidence(await app.extensions());
      setPlusStatus(
        result === "active" && activation.gateState !== "disabled"
          ? "unverified"
          : result,
      );
    } catch {
      setPlusStatus("unverified");
    }
  }, [activation.placement, activation.gateState]);

  const checkPublishedPlacement = useCallback((): boolean => {
    if (
      activationRequestPending.current ||
      activationPending ||
      checkInFlight.current ||
      activationFetcher.state !== "idle" ||
      verificationFetcher.state !== "idle"
    )
      return false;
    checkInFlight.current = true;
    setVerificationFailed(false);
    verificationFetcher.submit(
      { intent: "verify" },
      {
        method: "post",
        action: "/app/consent-activate",
      },
    );
    return true;
  }, [activationPending, activationFetcher.state, verificationFetcher]);

  const verifyDrawer = useCallback(async () => {
    if (
      activation.placement !== "non_plus_cart" ||
      activation.cartStatus !== "active"
    )
      return;
    const app = (window as unknown as AppBridgeExtensionReader).shopify?.app;
    if (typeof app?.extensions !== "function") {
      setDrawerStatus("unverified");
      return;
    }
    try {
      setDrawerStatus(matchCartDrawerEmbedEvidence(await app.extensions()));
    } catch {
      setDrawerStatus("unverified");
    }
  }, [activation.placement, activation.cartStatus]);

  useEffect(() => {
    void verifyPlus();
    void verifyDrawer();
  }, [verifyPlus, verifyDrawer]);

  // On a newly loaded settings page, the loader is the initial verification.
  // When a saved cart block is first observed, persist the fact that activation
  // has completed; this later enables safe one-click restoration after removal.
  useEffect(() => {
    if (
      activation.placement === "non_plus_cart" &&
      activation.cartStatus === "active" &&
      activation.setupPhase !== "active" &&
      activation.setupPhase !== "unknown" &&
      autoCheckedPhase.current !== activation.setupPhase
    ) {
      // A competing fetcher may temporarily prevent submission. Do not mark
      // this phase checked until the verification POST actually starts.
      if (checkPublishedPlacement()) {
        autoCheckedPhase.current = activation.setupPhase ?? "never";
      }
    }
  }, [
    activation.placement,
    activation.cartStatus,
    activation.setupPhase,
    checkPublishedPlacement,
  ]);

  // A merchant can leave Shopify's editor without saving. Recheck when they
  // return; never assume the original launch completed or poll continuously.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      if (activation.placement === "non_plus_cart") {
        checkPublishedPlacement();
        void verifyDrawer();
      } else void verifyPlus();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [activation.placement, checkPublishedPlacement, verifyPlus, verifyDrawer]);

  useEffect(() => {
    const result = verificationFetcher.data;
    if (
      verificationFetcher.state !== "idle" ||
      !result ||
      handledVerification.current === result
    )
      return;
    handledVerification.current = result;
    checkInFlight.current = false;
    setVerificationFailed(!result.ok);
    // A deliberate activation has priority. Its response will revalidate the page.
    if (!activationPending) void revalidate();
  }, [
    verificationFetcher.data,
    verificationFetcher.state,
    activationPending,
    revalidate,
  ]);

  // An automatic verification must not discard the merchant's Activate click.
  // Queue the one requested activation until its separate fetcher is free.
  useEffect(() => {
    if (
      !activationPending ||
      activationSubmitted.current ||
      checkInFlight.current ||
      verificationFetcher.state !== "idle" ||
      activationFetcher.state !== "idle"
    )
      return;
    activationSubmitted.current = true;
    activationFetcher.submit(
      { intent: "activate" },
      {
        method: "post",
        action: "/app/consent-activate",
      },
    );
  }, [
    activationPending,
    activationFetcher,
    activationFetcher.state,
    verificationFetcher.state,
    verificationFetcher.data,
  ]);

  useEffect(() => {
    const result = activationFetcher.data;
    if (
      activationFetcher.state !== "idle" ||
      !result ||
      handledActivation.current === result
    )
      return;
    handledActivation.current = result;
    activationSubmitted.current = false;
    activationRequestPending.current = false;
    setActivationPending(false);
    if (!result.ok || result.placement !== activation.placement) {
      pendingTab.current?.close();
      pendingTab.current = null;
      setActionFailed(true);
      return;
    }
    setActionFailed(false);
    if (pendingTab.current && !pendingTab.current.closed) {
      try {
        pendingTab.current.location.replace(result.editorUrl);
      } catch {
        pendingTab.current.close();
        setEditorFallbackUrl(result.editorUrl);
      }
      pendingTab.current = null;
    } else {
      // Shopify's embedded context may prohibit popups. Never strand setup.
      setEditorFallbackUrl(result.editorUrl);
    }
    void revalidate();
  }, [
    activationFetcher.data,
    activationFetcher.state,
    activation.placement,
    revalidate,
  ]);

  const activate = () => {
    if (
      activationRequestPending.current ||
      activationPending ||
      activationFetcher.state !== "idle"
    )
      return;
    activationRequestPending.current = true;
    setActionFailed(false);
    setEditorFallbackUrl(null);
    // Suppress the previous fetcher result while a new POST is starting.
    handledActivation.current = activationFetcher.data ?? null;
    try {
      pendingTab.current = window.open("about:blank", "_blank");
    } catch {
      pendingTab.current = null;
    }
    setActivationPending(true);
  };

  return (
    <WhatsAppCustomerConsent
      t={t}
      activation={activation}
      plusStatusOverride={
        activation.placement === "plus_checkout" ? plusStatus : undefined
      }
      drawerStatus={drawerStatus}
      onActivate={activate}
      busy={activationPending || activationFetcher.state !== "idle"}
      preparing={activationPending || activationFetcher.state !== "idle"}
      actionFailed={actionFailed}
      verificationFailed={verificationFailed}
      editorFallbackUrl={editorFallbackUrl}
    />
  );
}
