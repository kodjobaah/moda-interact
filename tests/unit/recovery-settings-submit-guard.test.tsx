// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsForm from "../../app/components/settings/SettingsForm";
vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate: vi.fn() }),
}));
let root: Root;
let host: HTMLDivElement;
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
it.each(["features", "recovery"] as const)(
  "%s form blocks double-click and repeated form/keyboard submit and exposes pending state",
  async (intent) => {
    let complete!: (v: unknown) => void;
    const fetcher = vi.fn(
      (url, options) =>
        new Promise((resolve) => {
          complete = resolve;
          void url;
          void options;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    await act(async () =>
      root.render(
        <StrictMode>
          <SettingsForm revision="version" intent={intent} t={(key) => key}>
            <input name="recoveryDelayMinutes" defaultValue="40" />
          </SettingsForm>
        </StrictMode>,
      ),
    );
    const form = host.querySelector("form")!;
    const button = host.querySelector("button")!;
    await act(async () => {
      button.click();
      button.click();
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "merchantFeatures.saving",
    );
    const body = fetcher.mock.calls[0][1].body as FormData;
    await act(async () =>
      complete({
        status: 400,
        redirected: false,
        json: async () => ({
          ok: false,
          operationId: body.get("operationId"),
          error: "INVALID_INPUT",
        }),
      }),
    );
    expect(button.disabled).toBe(false);
    expect(host.querySelector("input")?.value).toBe("40");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => button.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    const retryBody = fetcher.mock.calls[1][1].body as FormData;
    await act(async () =>
      complete({
        status: 200,
        redirected: false,
        json: async () => ({
          ok: true,
          operationId: retryBody.get("operationId"),
          revision: "new",
        }),
      }),
    );
    expect(button.disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "recoverySettings.saved",
    );
  },
);

import FeaturePreferences from "../../app/components/settings/FeaturePreferences";
it("feature switch double activation saves an explicit desired value once without reversal", async () => {
  const fetcher = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  await act(async () =>
    root.render(
      <FeaturePreferences
        snapshot={{
          revision: "old",
          features: [
            {
              id: "feature",
              key: "new_key",
              name: "New feature",
              description: null,
              enabled: false,
              effective: false,
              editable: true,
            },
          ],
        }}
        t={(k) => k}
      />,
    ),
  );
  const checkbox = host.querySelector("input")!;
  await act(async () => {
    checkbox.click();
    checkbox.click();
  });
  expect(checkbox.checked).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
    .body as FormData;
  expect(JSON.parse(String(body.get("preferences")))).toEqual([
    { featureId: "feature", enabled: true },
  ]);
});
