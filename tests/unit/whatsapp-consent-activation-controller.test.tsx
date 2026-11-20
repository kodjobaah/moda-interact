// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  callCount: 0,
  activation: { state: "idle", data: null as unknown, submit: vi.fn() },
  verification: { state: "idle", data: null as unknown, submit: vi.fn() },
  revalidate: vi.fn(),
}));

vi.mock("react-router", () => ({
  useFetcher: () => (++router.callCount % 2 === 1 ? router.activation : router.verification),
  useRevalidator: () => ({ revalidate: router.revalidate, state: "idle" }),
}));

import WhatsAppConsentActivationController from
  "@/routes/app/recovery-settings/WhatsAppConsentActivationController";
import type { WhatsAppConsentActivation } from
  "@/routes/app/recovery-settings/WhatsAppCustomerConsent";

const activation: WhatsAppConsentActivation = {
  placement: "non_plus_cart", cartStatus: "inactive", cartBlockPresence: "absent",
  plusStatus: "unsupported", gateState: "disabled", setupPhase: "never",
  cartThemeEditorUrl: "https://merchant.myshopify.com/admin/themes/current/editor?template=cart",
  checkoutEditorUrl: null, appProxyDefaultRoot: "/apps/moda-consent",
};
const editorUrl = "https://merchant.myshopify.com/admin/themes/current/editor?template=cart&addAppBlockId=test%2Fcart-consent";
let root: Root;
let host: HTMLDivElement;
let tab: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { replace: ReturnType<typeof vi.fn> } };

async function render() {
  await act(async () => root.render(
    <WhatsAppConsentActivationController t={(key) => key} activation={activation} />,
  ));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  router.callCount = 0;
  router.activation.state = "idle";
  router.activation.data = null;
  router.activation.submit.mockReset();
  router.verification.state = "idle";
  router.verification.data = null;
  router.verification.submit.mockReset();
  router.revalidate.mockReset();
  tab = { closed: false, close: vi.fn(), location: { replace: vi.fn() } };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Shopify consent activation during automatic verification", () => {
  it("keeps Activate clickable while verification runs, queues one click, then opens the editor", async () => {
    await render();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(router.verification.submit).toHaveBeenCalledWith({ intent: "verify" }, {
      method: "post", action: "/app/consent-activate",
    });
    router.verification.state = "submitting";
    await render();
    const button = host.querySelector<HTMLButtonElement>("button.moda-recovery-consent-action")!;
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.click();
      button.click();
    });
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(router.activation.submit).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    expect(host.textContent).toContain("activationPreparing");

    // An unrelated focus event cannot enqueue another verification over the click.
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(router.verification.submit).toHaveBeenCalledTimes(1);

    router.verification.state = "idle";
    router.verification.data = { ok: true, placement: "non_plus_cart", status: "inactive" };
    await render();
    expect(router.activation.submit).toHaveBeenCalledTimes(1);
    expect(router.activation.submit).toHaveBeenCalledWith({ intent: "activate" }, {
      method: "post", action: "/app/consent-activate",
    });

    router.activation.data = { ok: true, placement: "non_plus_cart", editorUrl };
    await render();
    expect(tab.location.replace).toHaveBeenCalledWith(editorUrl);
    expect(router.activation.submit).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("activationFailed");
  });

  it("submits directly when no verification is running, without duplicate clicks", async () => {
    await render();
    const button = host.querySelector<HTMLButtonElement>("button.moda-recovery-consent-action")!;
    await act(async () => { button.click(); button.click(); });
    expect(router.activation.submit).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it("offers an editor link if Shopify blocks the popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await render();
    const button = host.querySelector<HTMLButtonElement>("button.moda-recovery-consent-action")!;
    await act(async () => button.click());
    router.activation.data = { ok: true, placement: "non_plus_cart", editorUrl };
    await render();
    expect(host.querySelector<HTMLAnchorElement>(`a[href="${editorUrl}"]`)).not.toBeNull();
  });

  it("reports a rejected activation without claiming installation succeeded", async () => {
    await render();
    const button = host.querySelector<HTMLButtonElement>("button.moda-recovery-consent-action")!;
    await act(async () => button.click());
    router.activation.data = { ok: false, error: "SETUP_UNAVAILABLE" };
    await render();
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("activationFailed");
    expect(host.querySelector('[data-activation-status="active"]')).toBeNull();
  });
});
