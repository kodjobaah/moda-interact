import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({
  fetcher: { state: "idle", data: null },
  revalidate: vi.fn(),
}));

vi.mock("react-router", async () => {
  const React = await import("react");
  return {
    useFetcher: () => ({
      ...router.fetcher,
      Form: ({ children, ...props }: React.ComponentProps<"form">) =>
        React.createElement("form", props, children),
    }),
    useRevalidator: () => ({ revalidate: router.revalidate }),
  };
});

import StoreProfileSection from "../../app/components/settings/StoreProfileSection";

describe("Recovery Settings Store Profile section", () => {
  it("shows active and pending profile state and submits later changes to the shared selection action", () => {
    const html = renderToStaticMarkup(createElement(StoreProfileSection, {
      categories: [
        { id: "home", localizedDisplayName: "Home goods", localizedDescription: "Household products" },
        { id: "food", localizedDisplayName: "Food", localizedDescription: "Food products" },
      ],
      profile: {
        activeCategory: { id: "home", localizedDisplayName: "Home goods", localizedDescription: "Household products" },
        pendingCategory: { id: "food", localizedDisplayName: "Food", localizedDescription: "Food products" },
        pendingSelectionGeneration: 9,
        pendingState: "PENDING_PUBLICATION",
        pendingTemplate: { id: "template-1", key: "food.default", displayName: "Food default", editVersion: 4 },
      },
      t: (key, values) => values ? `${key}:${values.name}:${values.key}:${values.version}` : key,
    }));

    expect(html).toContain("Home goods");
    expect(html).toContain("Food");
    expect(html).toContain("storeProfile.pendingPublication");
    expect(html).toContain("storeProfile.templateProvenance:Food default:food.default:4");
    expect(html).toContain('class="moda-settings-disclosure moda-store-profile-disclosure"');
    expect(html).toContain('action="/app/store-profile/category"');
    expect(html).toContain('name="expectedPendingSelectionGeneration" value="9"');
    expect(html).toContain('value="food" selected=""');
    expect(html).not.toContain("promptText");
  });

  it("supports embedded presentation without repeating the section heading", () => {
    const html = renderToStaticMarkup(createElement(StoreProfileSection, {
      embedded: true,
      categories: [],
      profile: {
        activeCategory: null,
        pendingCategory: null,
        pendingSelectionGeneration: 0,
        pendingState: "NONE",
        pendingTemplate: null,
      },
      t: (key) => key,
    }));

    expect(html).toContain('class="moda-recovery-embedded-panel"');
    expect(html).toContain('aria-label="storeProfile.title"');
    expect(html).not.toContain('id="store-profile-heading"');
  });

  it("shows only the unavailable state when there is no selectable category", () => {
    const html = renderToStaticMarkup(createElement(StoreProfileSection, {
      categories: [],
      profile: {
        activeCategory: null,
        pendingCategory: null,
        pendingSelectionGeneration: 0,
        pendingState: "NONE",
        pendingTemplate: null,
      },
      t: (key) => key,
    }));

    expect(html).toContain("storeProfile.configurationUnavailable");
    expect(html).not.toContain('action="/app/store-profile/category"');
  });
});
