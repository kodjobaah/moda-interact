// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  fetcher: { state: "idle", data: null, submit: vi.fn() },
  navigate: vi.fn(),
}));

vi.mock("react-router", () => ({
  useFetcher: () => router.fetcher,
  useNavigate: () => router.navigate,
}));

import Onboarding from "../../app/components/onboarding/Onboarding.jsx";

const categories = [
  { id: "first", localizedDisplayName: "First", localizedDescription: "First category" },
  { id: "suggested", localizedDisplayName: "Suggested", localizedDescription: "Suggested category" },
  { id: "pending", localizedDisplayName: "Pending", localizedDescription: "Pending category" },
];

describe("onboarding Store Category selection", () => {
  let root;
  let container;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    router.fetcher.state = "idle";
    router.fetcher.data = null;
    router.fetcher.submit.mockReset();
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
    storeCategories: categories,
    pendingCategoryId: "pending",
    pendingSelectionGeneration: 6,
    suggestedCategoryId: "suggested",
    ...overrides,
  });

  it("restores pending selection and persists through either plan CTA before navigating", async () => {
    await act(async () => root.render(render()));
    expect(container.querySelector("#onboarding-store-category").value).toBe("pending");
    const buttons = container.querySelectorAll("s-button");
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(router.fetcher.submit).toHaveBeenCalledTimes(2);
    expect(router.fetcher.submit).toHaveBeenCalledWith(
      { categoryId: "pending", expectedPendingSelectionGeneration: "6" },
      { method: "post", action: "/app/store-profile/category" },
    );
    expect(router.navigate).not.toHaveBeenCalled();

    router.fetcher.data = { ok: true, pendingSelectionGeneration: 7 };
    await act(async () => root.render(render()));
    expect(router.navigate).toHaveBeenCalledWith("/app/billing/select");
  });

  it("disables both plan CTAs when no selectable category is available", async () => {
    await act(async () => root.render(render({ storeCategories: [] })));
    expect(container.querySelectorAll("s-button[disabled]")).toHaveLength(2);
    expect(container.textContent).toContain("Store categories are temporarily unavailable.");
    expect(router.fetcher.submit).not.toHaveBeenCalled();
  });
});