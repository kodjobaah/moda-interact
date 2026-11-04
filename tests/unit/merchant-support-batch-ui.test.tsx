// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../app/utils/merchant-i18n", () => ({ createMerchantI18n: () => ({ t: (s: string) => s, formatNumber: String, formatDateTime: String }) }));
vi.mock("../../app/services/shop/merchant-request-context.server", () => ({ getMerchantRequestContext: vi.fn() }));
vi.mock("../../app/services/merchant-support/merchant-support.service", () => ({}));
import MerchantSupport from "../../app/routes/app/merchant-support/route";
let root: Root; let host: HTMLDivElement; let router: ReturnType<typeof createMemoryRouter>;
let loader: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("React", React); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  loader = vi.fn(() => ({ merchantUi: {}, totalPages: 1, items: Array.from({length: 50}, (_, i) => ({
    id: `message-${i}`, kind: "ADMINISTRATIVE", state: "AVAILABLE", readAt: loader.mock.calls.length > 1 ? "2026-11-04T00:00:00Z" : null,
    originalBody: "Help", displayBody: "Help", sourceLanguageTag: "en", createdAt: "2026-11-04T00:00:00Z",
  })) }));
  router = createMemoryRouter([{path: "/app/merchant-support", loader, Component: MerchantSupport}], {initialEntries: ["/app/merchant-support"]});
});
afterEach(async () => { await act(async () => root.unmount()); router.dispose(); host.remove(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(<RouterProvider router={router} />)); }
it("posts fifty rendered IDs once and triggers one router refresh", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({marked: true}) }); vi.stubGlobal("fetch", fetcher);
  await mount();
  expect(fetcher).toHaveBeenCalledOnce(); expect(loader).toHaveBeenCalledTimes(2);
  const form = fetcher.mock.calls[0][1].body as FormData;
  expect(form.get("intent")).toBe("read-batch"); expect(JSON.parse(String(form.get("messageIds")))).toHaveLength(50);
});
it.each(["false", "http", "transport"])("does not refresh after %s failure", async kind => {
  vi.stubGlobal("fetch", kind === "transport" ? vi.fn().mockRejectedValue(new Error("offline")) : vi.fn().mockResolvedValue({ok: kind !== "http", json: async () => ({ marked: false })}));
  await mount(); expect(loader).toHaveBeenCalledOnce();
});
it("does not refresh after unmount while the request is pending", async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { finish = resolve; })));
  await mount(); await act(async () => root.unmount());
  await act(async () => { finish({ok: true, json: async () => ({marked: true})}); });
  expect(loader).toHaveBeenCalledOnce(); root = createRoot(host);
});
