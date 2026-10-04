// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MerchantKnowledgeUploadForm from "../../app/components/settings/MerchantKnowledgeUploadForm";

const mocks = vi.hoisted(() => ({ revalidate: vi.fn() }));
vi.mock("react-router", () => ({ useRevalidator: () => ({ revalidate: mocks.revalidate }) }));

let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

const catalogue = [{
  purpose: { key: "FAQ", displayName: "FAQ" },
  dataFormat: {
    key: "CSV",
    displayName: "CSV",
    canonicalExtension: ".csv",
    acceptedContentTypes: ["text/csv"],
  },
}];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({
      assetId: "asset-1",
      uploadUrl: "https://r2.example/signed-put",
      requiredHeaders: { "Content-Type": "text/csv", "If-None-Match": "*" },
    }) })
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, queued: true }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", { subtle: { digest: async () => new Uint8Array(32).buffer } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("uploads bytes directly to R2 without credentials, hashes, then finalizes", async () => {
  await act(async () => root.render(
    <MerchantKnowledgeUploadForm
      catalogue={catalogue}
      maxUploadBytes={1024}
      defaultLanguageTag="en"
      supportedLanguageTags={["en", "fr"]}
      t={(key) => key}
    />,
  ));

  expect(host.querySelector("form.moda-merchant-knowledge-upload-form")).not.toBeNull();
  const nameInput = host.querySelector<HTMLInputElement>('input:not([type="file"])')!;
  const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["a,b\n1,2"], "faq.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("a,b\n1,2").buffer });

  await act(async () => {
    nameInput.value = "FAQ import";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  expect(fetchMock).toHaveBeenNthCalledWith(1, "/app/merchant-knowledge/upload-intent", expect.objectContaining({
    method: "POST",
    credentials: "same-origin",
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, "https://r2.example/signed-put", expect.objectContaining({
    method: "PUT",
    credentials: "omit",
    body: file,
    headers: { "Content-Type": "text/csv", "If-None-Match": "*" },
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(3, "/app/merchant-knowledge/upload-finalize", expect.objectContaining({ method: "POST" }));
  expect(mocks.revalidate).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Queued");
});

it("derives picker filters and rejects mismatched files before requesting an intent", async () => {
  await act(async () => root.render(
    <MerchantKnowledgeUploadForm
      catalogue={catalogue}
      maxUploadBytes={1024}
      defaultLanguageTag="en"
      supportedLanguageTags={["en"]}
      t={(key) => key}
    />,
  ));
  const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(fileInput.accept).toContain(".csv");
  expect(fileInput.accept).toContain("text/csv");
  const file = new File(["data"], "faq.xlsx", { type: "text/csv" });
  await act(async () => {
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Upload failed");
});

it("shows saved-for-processing when finalization succeeds without queue publication", async () => {
  fetchMock.mockReset()
    .mockResolvedValueOnce({ ok: true, json: async () => ({
      assetId: "asset-1",
      uploadUrl: "https://r2.example/signed-put",
      requiredHeaders: { "Content-Type": "text/csv", "If-None-Match": "*" },
    }) })
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, queued: false }) });
  await act(async () => root.render(
    <MerchantKnowledgeUploadForm
      catalogue={catalogue}
      maxUploadBytes={1024}
      defaultLanguageTag="en"
      supportedLanguageTags={["en"]}
      t={(key) => key}
    />,
  ));

  const nameInput = host.querySelector<HTMLInputElement>('input:not([type="file"])')!;
  const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["a,b\n1,2"], "faq.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("a,b\n1,2").buffer });
  await act(async () => {
    nameInput.value = "FAQ import";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  expect(host.textContent).toContain("Saved for processing");
  expect(host.textContent).not.toContain("Queued");
});