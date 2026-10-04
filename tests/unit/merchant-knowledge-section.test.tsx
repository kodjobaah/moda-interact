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
  maxUploadBytes: 10_485_760,
  configuredCount: 0,
  planEligibleSourceCount: 0,
  defaultLanguageTag: "en",
  supportedLanguageTags: MODA_SUPPORTED_LANGUAGE_TAGS,
  catalogue: [{
    purpose: { key: "FAQ", displayName: "Frequently asked questions" },
    dataFormat: {
      key: "WEB_PAGE",
      displayName: "Web page",
      inputKind: "REMOTE_URL",
      canonicalExtension: null,
      acceptedContentTypes: [],
    },
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

  expect(host.querySelector("#conversation-features")).not.toBeNull();
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  expect(host.querySelector('input[type="checkbox"][data-feature-id="feature-mk"]')).not.toBeNull();
  expect(host.querySelector('form[action="/app/merchant-knowledge/source"]')).not.toBeNull();
  expect(host.querySelector(".moda-merchant-knowledge-panel")).not.toBeNull();
  expect(host.querySelector("form.moda-merchant-knowledge-form")).not.toBeNull();
  expect(host.querySelectorAll("details.moda-merchant-knowledge-add")).toHaveLength(1);
  expect(host.querySelector("details.moda-merchant-knowledge-add > summary")?.textContent).toContain("Add web page");
  expect(host.querySelector('input[name="url"]')).not.toBeNull();
  expect(host.textContent).toContain("Ingestion and retrieval are disabled");
  expect(host.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
});

it("puts recovery behaviour first and progressively discloses lower-frequency context", async () => {
  const { readFileSync } = await import("node:fs");
  const view = readFileSync("app/routes/app/recovery-settings/RecoverySettingsView.tsx", "utf8");
  const recoverySettings = view.indexOf("<SettingsForm revision={data.revision}");
  const features = view.indexOf("<FeaturePreferences");
  const context = view.indexOf('className="moda-recovery-panel moda-recovery-context-panel"');
  const storeProfile = view.indexOf("<StoreProfileSection");
  const merchantKnowledge = view.indexOf("<MerchantKnowledgeSection");

  expect(recoverySettings).toBeGreaterThanOrEqual(0);
  expect(recoverySettings).toBeLessThan(features);
  expect(features).toBeLessThan(context);
  expect(context).toBeLessThan(storeProfile);
  expect(storeProfile).toBeLessThan(merchantKnowledge);
  expect(view).toContain("Store &amp; assistant context");
  expect(view).toContain("moda-recovery-context-disclosure");
  expect(view).toContain("<StoreProfileSection\n                  embedded");
  expect(view).toContain("<MerchantKnowledgeSection\n                  embedded");
});
