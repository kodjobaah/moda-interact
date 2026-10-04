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


function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("HTMLInputElement.value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

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
    setInputValue(nameInput, "FAQ import");
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
  expect(host.textContent).toContain("Saved for processing");
  expect(host.textContent).not.toContain("Queued");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.textContent).toContain("Upload file");
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
    setInputValue(nameInput, "FAQ import");
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
it("accepts a valid dropped file and uses the normal upload pipeline", async () => {
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
  const submitButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const dropzone = host.querySelector<HTMLDivElement>(".moda-merchant-knowledge-dropzone")!;
  const file = new File(["a,b\n1,2"], "dropped-faq.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("a,b\n1,2").buffer });
  const dataTransfer = {
    files: {
      0: file,
      length: 1,
      item: (index: number) => index === 0 ? file : null,
    },
    dropEffect: "none",
  };

  expect(nameInput.value).toBe("");
  expect(fileInput.required).toBe(false);
  expect(fileInput.getAttribute("aria-required")).toBe("true");
  expect(submitButton.disabled).toBe(true);

  await act(async () => {
    const dragEnter = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(dragEnter, "dataTransfer", { value: dataTransfer });
    dropzone.dispatchEvent(dragEnter);
  });
  expect(dropzone.classList.contains("is-drag-active")).toBe(true);

  await act(async () => {
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    dropzone.dispatchEvent(drop);
  });

  expect(dropzone.classList.contains("is-drag-active")).toBe(false);
  expect(dropzone.classList.contains("has-file")).toBe(true);
  expect(host.textContent).toContain("dropped-faq.csv");
  expect(nameInput.value).toBe("dropped faq");
  expect(submitButton.disabled).toBe(false);

  await act(async () => {
    submitButton.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  expect(fetchMock).toHaveBeenNthCalledWith(2, "https://r2.example/signed-put", expect.objectContaining({
    method: "PUT",
    credentials: "omit",
    body: file,
  }));
});


it("keeps an explicitly entered source name when a file is selected", async () => {
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
  const file = new File(["a,b\n1,2"], "faq-import.csv", { type: "text/csv" });

  await act(async () => {
    setInputValue(nameInput, "Customer FAQ catalogue");
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(nameInput.value).toBe("Customer FAQ catalogue");
});


it("shows and reports a safe diagnostic when R2 rejects a dropped upload", async () => {
  fetchMock.mockReset()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      assetId: "asset-403",
      uploadUrl: "https://r2.example/signed-put",
      requiredHeaders: { "Content-Type": "text/csv", "If-None-Match": "*" },
    }) })
    .mockResolvedValueOnce({ ok: false, status: 403 })
    .mockResolvedValueOnce({ ok: true, status: 204 });

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
  const submitButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const file = new File(["a,b\n1,2"], "pricing.csv", { type: "text/csv" });

  await act(async () => {
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await act(async () => {
    submitButton.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  expect(host.textContent).toContain("Upload failed (STORAGE_HTTP_403)");
  expect(fetchMock).toHaveBeenNthCalledWith(3, "/app/merchant-knowledge/upload-failure", expect.objectContaining({
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
  }));
  const report = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string);
  expect(report).toEqual({
    stage: "storage_put",
    assetId: "asset-403",
    purposeKey: "FAQ",
    dataFormatKey: "CSV",
    sizeBytes: file.size,
    contentType: "text/csv",
    statusCode: 403,
    errorCode: "STORAGE_HTTP_403",
  });
  expect(JSON.stringify(report)).not.toContain("pricing.csv");
});
