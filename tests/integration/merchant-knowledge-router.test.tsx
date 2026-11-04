// @vitest-environment jsdom
import React, {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {RouterProvider} from "react-router";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {knowledgeRouter, knowledgeRouterData} from "../helpers/merchant-knowledge-router-fixtures";
let root: Root, host: HTMLDivElement, router: ReturnType<typeof knowledgeRouter>;
let data: ReturnType<typeof knowledgeRouterData>; let loader: ReturnType<typeof vi.fn<() => unknown>>;
beforeEach(() => {
 vi.stubGlobal("React", React); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 host = document.createElement("div"); document.body.append(host); root = createRoot(host); data = knowledgeRouterData(); loader = vi.fn(() => structuredClone(data));
});
afterEach(async () => {await act(async () => root.unmount()); router?.dispose(); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();});
async function mount(action = vi.fn(() => ({ok: true}))) {router = knowledgeRouter(loader, action); await act(async () => root.render(<RouterProvider router={router}/>)); return action;}
it.each(["source", "refresh", "reprocess", "reorder", "delete"])("%s action gets exactly one router-managed reload", async operation => {
 const action = await mount();
 await act(async () => {
  if (operation === "reorder") (host.querySelector('button[aria-label="merchantKnowledge.actions.moveDown"]') as HTMLButtonElement).click();
  else (host.querySelector(`form[action="/app/merchant-knowledge/${operation}"]`) as HTMLFormElement).dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));
 });
 expect(action).toHaveBeenCalledOnce(); expect(loader).toHaveBeenCalledTimes(2);
 await act(async () => {await Promise.resolve();}); expect(loader).toHaveBeenCalledTimes(2);
});
it("failed action does not create an extra success-effect loop", async () => {
 const action = await mount(vi.fn(() => ({ok: false, error: "CONFLICT"})));
 await act(async () => (host.querySelector('form[action="/app/merchant-knowledge/refresh"]') as HTMLFormElement).dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
 expect(action).toHaveBeenCalledOnce(); expect(loader).toHaveBeenCalledTimes(2);
});
it("keeps one sixty-second episode through repeated reloads/visibility changes and starts a later episode", async () => {
 vi.useFakeTimers(); vi.setSystemTime(0); data.sources[0].revision!.status = "PENDING";
 let visibility = "visible"; vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
 await mount();
 for (let i = 0; i < 10; i++) await act(async () => {await vi.advanceTimersByTimeAsync(4000);});
 expect(loader).toHaveBeenCalledTimes(11);
 visibility = "hidden"; await act(async () => {await vi.advanceTimersByTimeAsync(20000);});
 const expired = loader.mock.calls.length; visibility = "visible";
 await act(async () => {await vi.advanceTimersByTimeAsync(20000);}); expect(loader).toHaveBeenCalledTimes(expired);
 data.sources[0].revision!.status = "ACTIVE"; await act(async () => {await router.revalidate();});
 data.sources[0].revision!.status = "PROCESSING"; await act(async () => {await router.revalidate();});
 const before = loader.mock.calls.length; await act(async () => {await vi.advanceTimersByTimeAsync(4000);}); expect(loader).toHaveBeenCalledTimes(before + 1);
});
it("slow loader prevents overlapping polls and unmount clears timers", async () => {
 vi.useFakeTimers(); data.sources[0].revision!.status = "PENDING"; await mount();
 let finish!: (value: unknown) => void; loader.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
 await act(async () => {await vi.advanceTimersByTimeAsync(4000);}); const calls = loader.mock.calls.length;
 await act(async () => {await vi.advanceTimersByTimeAsync(20000);}); expect(loader).toHaveBeenCalledTimes(calls);
 await act(async () => {finish(structuredClone(data));});
 await act(async () => root.unmount()); const after = loader.mock.calls.length;
 await act(async () => {await vi.advanceTimersByTimeAsync(60000);}); expect(loader).toHaveBeenCalledTimes(after); root = createRoot(host);
});

it("plain-fetch upload finalization explicitly reloads once using the real router", async () => {
 const fetcher = vi.fn().mockResolvedValueOnce({ok: true, json: async () => ({assetId: "fixture", uploadUrl: "https://fixture.example/upload", requiredHeaders: {"Content-Type": "text/csv"}})})
  .mockResolvedValueOnce({ok: true}).mockResolvedValueOnce({ok: true, json: async () => ({ok: true, queued: false})});
 vi.stubGlobal("fetch", fetcher); vi.stubGlobal("crypto", {subtle: {digest: async () => new Uint8Array(32).buffer}});
 await mount();
 const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement;
 const file = new File(["x"], "fixture.csv", {type: "text/csv"}); Object.defineProperty(file, "arrayBuffer", {value: async () => new Uint8Array([120]).buffer});
 await act(async () => {Object.defineProperty(fileInput, "files", {configurable: true, value: [file]}); fileInput.dispatchEvent(new Event("change", {bubbles: true}));});
 await act(async () => {host.querySelector('form.moda-merchant-knowledge-upload-form')!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true}));});
 expect(fetcher).toHaveBeenCalledTimes(3); expect(loader).toHaveBeenCalledTimes(2);
});
it("unavailable entitlement retains sources read-only and uses existing localized unavailable copy", async () => {
 data.entitlementState = "unavailable"; data.planEntitled = false; data.sources[0].dormantReason = null;
 await mount(); expect(host.textContent).toContain("common.unavailable"); expect(host.textContent).toContain("web");
 expect(host.textContent).not.toContain("merchantKnowledge.configurationUnavailable");
 expect([...host.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
});
