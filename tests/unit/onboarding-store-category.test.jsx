// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  resumeFetcher: { state: "idle", data: null, submit: vi.fn() },
  navigate: vi.fn(),
}));

vi.mock("react-router", () => ({
  useFetcher: () => router.resumeFetcher,
  useNavigate: () => router.navigate,
}));

import Onboarding from "../../app/components/onboarding/Onboarding.jsx";

describe("Shopify onboarding without category prerequisites", () => {
  let root;
  let container;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    router.resumeFetcher.state = "idle";
    router.resumeFetcher.data = null;
    router.resumeFetcher.submit.mockReset();
    router.navigate.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = (overrides = {}) => createElement(Onboarding, {
    merchantUi: { locale: "en", timeZone: "UTC" },
    pricingCatalogue: [],
    ...overrides,
  });

  it("allows either plan button to navigate immediately with no Store Category", async () => {
    await act(async () => root.render(render()));
    expect(container.querySelector("#onboarding-store-category")).toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const buttons = container.querySelectorAll("s-button");
    expect(buttons).toHaveLength(2);
    expect(container.querySelectorAll("s-button[disabled]")).toHaveLength(0);
    await act(async () => buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(router.navigate).toHaveBeenNthCalledWith(1, "/app/billing/select");
    expect(router.navigate).toHaveBeenNthCalledWith(2, "/app/billing/select");
    expect(router.resumeFetcher.submit).not.toHaveBeenCalled();
  });

  it("ignores stale category props; billing navigation never submits category selection", async () => {
    await act(async () => root.render(render({
      storeCategories: [], pendingCategoryId: "stale-category", pendingSelectionGeneration: 9,
    })));
    await act(async () => container.querySelector("s-button").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(router.navigate).toHaveBeenCalledWith("/app/billing/select");
    expect(router.resumeFetcher.submit).not.toHaveBeenCalled();
  });

  it("resumes a selected subscription without a category or generation, once per mount", async () => {
    await act(async () => root.render(render({ resumeExistingSubscription: true })));
    expect(router.resumeFetcher.submit).toHaveBeenCalledOnce();
    expect(router.resumeFetcher.submit).toHaveBeenCalledWith(
      {}, { method: "post", action: "/app/onboarding/resume" },
    );
    await act(async () => root.render(render({ resumeExistingSubscription: true })));
    expect(router.resumeFetcher.submit).toHaveBeenCalledOnce();
    router.resumeFetcher.data = { ok: true, onboardingCompleted: true };
    await act(async () => root.render(render({ resumeExistingSubscription: true })));
    expect(router.navigate).toHaveBeenCalledWith("/app");
  });
});
