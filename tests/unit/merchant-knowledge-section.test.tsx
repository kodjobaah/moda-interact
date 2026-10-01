// @vitest-environment jsdom
import { act, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";

const mocks = vi.hoisted(() => ({
  revalidate: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: mocks.submit }),
  useRevalidator: () => ({ revalidate: mocks.revalidate }),
}));
vi.mock("../../app/components/settings/SettingsForm", () => ({
  default: ({ children }: { children: React.ReactNode }) => <form>{children}</form>,
}));

import FeaturePreferences from "../../app/components/settings/FeaturePreferences";
import MerchantKnowledgeSection from "../../app/components/settings/MerchantKnowledgeSection";

let root: Root;
let host: HTMLDivElement;

const knowledge: Parameters<typeof MerchantKnowledgeSection>[0]["data"] = {
  planEntitled: true,
  merchantEnabled: false,
  effectiveEnabled: false,
  maxKnowledgeSources: 2,
  configuredCount: 0,
  planEligibleSourceCount: 0,
  defaultLanguageTag: "en",
  supportedLanguageTags: MODA_SUPPORTED_LANGUAGE_TAGS,
  catalogue: [{
    purpose: { key: "FAQ", displayName: "Frequently asked questions" },
    dataFormat: { key: "WEB_PAGE", displayName: "Web page" },
  }],
  sources: [],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps source configuration available while OFF and uses only FeaturePreferences for activation", async () => {
  await act(async () => root.render(
    <Fragment>
      <FeaturePreferences
        snapshot={{
          revision: "revision-1",
          features: [{
            id: "feature-mk",
            key: "merchant_knowledge",
            name: "Merchant Knowledge",
            description: null,
            enabled: false,
            effective: false,
            editable: true,
          }],
        }}
        t={(key) => key}
      />
      <MerchantKnowledgeSection data={knowledge} t={(key) => key} />
    </Fragment>,
  ));

  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  expect(host.querySelector('input[type="checkbox"][data-feature-id="feature-mk"]')).not.toBeNull();
  expect(host.querySelector('form[action="/app/merchant-knowledge/source"]')).not.toBeNull();
  expect(host.querySelector('input[name="url"]')).not.toBeNull();
  expect(host.textContent).toContain("Ingestion and retrieval are disabled");
  expect(host.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
});

it("orders Conversation Features, Store Profile, Merchant Knowledge, then recovery controls", async () => {
  const { readFileSync } = await import("node:fs");
  const view = readFileSync("app/routes/app/recovery-settings/RecoverySettingsView.tsx", "utf8");
  const features = view.indexOf("<FeaturePreferences");
  const storeProfile = view.indexOf("<StoreProfileSection");
  const merchantKnowledge = view.indexOf("<MerchantKnowledgeSection");
  const recoverySettings = view.indexOf("<SettingsForm revision={data.revision}");

  expect(features).toBeGreaterThanOrEqual(0);
  expect(features).toBeLessThan(storeProfile);
  expect(storeProfile).toBeLessThan(merchantKnowledge);
  expect(merchantKnowledge).toBeLessThan(recoverySettings);
});