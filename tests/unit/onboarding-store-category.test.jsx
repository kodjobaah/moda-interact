// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  categoryFetcher: { state: "idle", data: null, submit: vi.fn() },
  resumeFetcher: { state: "idle", data: null, submit: vi.fn() },
  fetcherCalls: 0,
  navigate: vi.fn(),
}));

vi.mock("react-router", () => ({
  useFetcher: () => {
    const fetcher = router.fetcherCalls % 2 === 0
      ? router.categoryFetcher
      : router.resumeFetcher;
    router.fetcherCalls += 1;
    return fetcher;
  },
  useNavigate: () => router.navigate,
}));

import Onboarding from "../../app/components/onboarding/Onboarding.jsx";

const categories = [
  { id: "first", localizedDisplayName: "First", localizedDescription: "First category", mappings: [] },
  {
    id: "suggested",
    localizedDisplayName: "Suggested",
    localizedDescription: "Suggested category",
    mappings: [
      { id: "suggested-a", localizedDisplayName: "Suggested A" },
      { id: "suggested-b", localizedDisplayName: "Suggested B" },
    ],
  },
  {
    id: "pending",
    localizedDisplayName: "Pending",
    localizedDescription: "Pending category",
    mappings: [
      { id: "pending-a", localizedDisplayName: "Pending A" },
      { id: "pending-b", localizedDisplayName: "Pending B" },
    ],
  },
];

describe("onboarding Store Category selection", () => {
  let root;
  let container;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    router.categoryFetcher.state = "idle";
    router.categoryFetcher.data = null;
    router.categoryFetcher.submit.mockReset();
    router.resumeFetcher.state = "idle";
    router.resumeFetcher.data = null;
    router.resumeFetcher.submit.mockReset();
    router.fetcherCalls = 0;
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
    pendingMappingIds: ["pending-b"],
    suggestedCategoryId: "suggested",
    suggestedMappingIds: ["suggested-a"],
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
    expect(router.categoryFetcher.submit).toHaveBeenCalledTimes(2);
    const [submitted, options] = router.categoryFetcher.submit.mock.calls[0];
    expect(Array.from(submitted.entries())).toEqual([
      ["categoryId", "pending"],
      ["expectedPendingSelectionGeneration", "6"],
      ["mappingId", "pending-b"],
    ]);
    expect(options).toEqual({ method: "post", action: "/app/store-profile/category" });
    expect(router.navigate).not.toHaveBeenCalled();

    router.categoryFetcher.data = { ok: true, pendingSelectionGeneration: 7 };
    await act(async () => root.render(render()));
    expect(router.navigate).toHaveBeenCalledWith("/app/billing/select");
  });


  it("resumes an already confirmed Shopify subscription after persisting the Store Category", async () => {
    await act(async () => root.render(render({ resumeExistingSubscription: true })));
    const button = container.querySelector("s-button");

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const [submitted, options] = router.categoryFetcher.submit.mock.calls[0];
    expect(Array.from(submitted.entries())).toEqual([
      ["categoryId", "pending"],
      ["expectedPendingSelectionGeneration", "6"],
      ["mappingId", "pending-b"],
    ]);
    expect(options).toEqual({ method: "post", action: "/app/store-profile/category" });

    router.categoryFetcher.data = { ok: true, pendingSelectionGeneration: 7 };
    await act(async () => root.render(render({ resumeExistingSubscription: true })));
    expect(router.resumeFetcher.submit).toHaveBeenCalledWith(
      { expectedPendingSelectionGeneration: "7" },
      { method: "post", action: "/app/onboarding/resume" },
    );
    expect(router.navigate).not.toHaveBeenCalled();

    router.resumeFetcher.data = { ok: true, onboardingCompleted: true };
    await act(async () => root.render(render({ resumeExistingSubscription: true })));
    expect(router.navigate).toHaveBeenCalledWith("/app");
  });

  it("automatically resumes a persisted pending category after loader revalidation or reload", async () => {
    await act(async () => root.render(render({
      resumeExistingSubscription: true,
      pendingCategoryId: "pending",
      pendingSelectionGeneration: 6,
    })));

    expect(router.resumeFetcher.submit).toHaveBeenCalledWith(
      { expectedPendingSelectionGeneration: "6" },
      { method: "post", action: "/app/onboarding/resume" },
    );
    expect(router.categoryFetcher.submit).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });


  it("preselects Shopify-suggested mappings and lets the merchant change the checkbox set", async () => {
    await act(async () => root.render(render({
      pendingCategoryId: null,
      pendingMappingIds: [],
      pendingSelectionGeneration: 0,
    })));

    expect(container.querySelector("#onboarding-store-category").value).toBe("suggested");
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.map((input) => [input.value, input.checked])).toEqual([
      ["suggested-a", true],
      ["suggested-b", false],
    ]);

    await act(async () => {
      checkboxes[1].click();
    });
    await act(async () => {
      container.querySelector("s-button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const [submitted] = router.categoryFetcher.submit.mock.calls[0];
    expect(Array.from(submitted.entries())).toEqual([
      ["categoryId", "suggested"],
      ["expectedPendingSelectionGeneration", "0"],
      ["mappingId", "suggested-a"],
      ["mappingId", "suggested-b"],
    ]);
  });

  it("disables both plan CTAs when no selectable category is available", async () => {
    await act(async () => root.render(render({ storeCategories: [] })));
    expect(container.querySelectorAll("s-button[disabled]")).toHaveLength(2);
    expect(container.textContent).toContain("Store categories are temporarily unavailable.");
    expect(router.categoryFetcher.submit).not.toHaveBeenCalled();
  });
});