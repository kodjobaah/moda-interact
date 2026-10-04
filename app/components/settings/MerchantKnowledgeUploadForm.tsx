import { useRef, useState } from "react";
import { useRevalidator } from "react-router";

type UploadFormat = {
  purpose: { key: string; displayName: string };
  dataFormat: {
    key: string;
    displayName: string;
    canonicalExtension: string | null;
    acceptedContentTypes: unknown;
  };
};
type Translate = (key: string, values?: Record<string, string | number>) => string;
type Stage = "idle" | "preparing" | "uploading" | "finalizing" | "failed";
type UploadFailureStage = "intent" | "storage_put" | "client_hash" | "finalize";

class UploadPipelineError extends Error {
  constructor(
    readonly code: string,
    readonly stage: UploadFailureStage,
    readonly statusCode?: number,
  ) {
    super(code);
    this.name = "UploadPipelineError";
  }
}

function contentTypes(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function localized(t: Translate, key: string, fallback: string, values?: Record<string, string | number>): string {
  const result = t(key, values);
  return result === key ? fallback : result;
}

function sourceNameFromFile(fileName: string, canonicalExtension: string | null): string {
  const trimmed = fileName.trim();
  const extension = canonicalExtension?.toLowerCase();
  const withoutExtension = extension && trimmed.toLowerCase().endsWith(extension)
    ? trimmed.slice(0, -extension.length)
    : trimmed.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || withoutExtension || trimmed).slice(0, 160);
}

export default function MerchantKnowledgeUploadForm({
  catalogue,
  maxUploadBytes,
  defaultLanguageTag,
  supportedLanguageTags,
  sourceId,
  initialName,
  initialLanguageTag,
  t,
}: {
  catalogue: UploadFormat[];
  maxUploadBytes: number;
  defaultLanguageTag: string;
  supportedLanguageTags: readonly string[];
  sourceId?: string;
  initialName?: string;
  initialLanguageTag?: string;
  t: Translate;
}) {
  const revalidator = useRevalidator();
  const dragDepth = useRef(0);
  const [pairIndex, setPairIndex] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [name, setName] = useState(initialName ?? "");
  const nameEdited = useRef(Boolean(initialName?.trim()));
  const [languageTag, setLanguageTag] = useState(initialLanguageTag ?? defaultLanguageTag);
  const [stage, setStage] = useState<Stage>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selected = catalogue[pairIndex];
  const accepted = selected ? contentTypes(selected.dataFormat.acceptedContentTypes) : [];
  const accept = selected
    ? [selected.dataFormat.canonicalExtension, ...accepted].filter(Boolean).join(",")
    : "";
  const busy = stage === "preparing" || stage === "uploading" || stage === "finalizing";
  const selectedFormatLabel = selected
    ? localized(t, `merchantKnowledge.dataFormats.${selected.dataFormat.key}.label`, selected.dataFormat.displayName)
    : "";

  function validFile(candidate: File): boolean {
    const extension = selected?.dataFormat.canonicalExtension?.toLowerCase();
    const fileType = candidate.type.split(";", 1)[0]!.trim().toLowerCase();
    return Boolean(
      selected
      && candidate.size > 0
      && candidate.size <= maxUploadBytes
      && extension
      && candidate.name.toLowerCase().endsWith(extension)
      && accepted.some((contentType) => contentType.split(";", 1)[0]!.trim().toLowerCase() === fileType),
    );
  }

  function chooseFile(candidate: File | null): boolean {
    if (!candidate) {
      setFile(null);
      return false;
    }
    if (!validFile(candidate)) {
      setFile(null);
      setFailure(localized(t, "merchantKnowledge.upload.failed", "Upload failed"));
      setStage("failed");
      return false;
    }
    setFile(candidate);
    if (!nameEdited.current && selected) {
      setName(sourceNameFromFile(candidate.name, selected.dataFormat.canonicalExtension));
    }
    setFailure(null);
    setNotice(null);
    setStage("idle");
    return true;
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (busy) return;
    dragDepth.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (busy) return;
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (busy) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (busy) return;
    chooseFile(event.dataTransfer.files.item(0));
  }

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !selected || busy) return;
    setFailure(null);
    setNotice(null);
    if (!validFile(file)) {
      setFailure(localized(t, "merchantKnowledge.upload.failed", "Upload failed"));
      setStage("failed");
      return;
    }

    let failureStage: UploadFailureStage = "intent";
    let assetId: string | undefined;

    try {
      setStage("preparing");
      const intentResponse = await fetch("/app/merchant-knowledge/upload-intent", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purposeKey: selected.purpose.key,
          dataFormatKey: selected.dataFormat.key,
          originalFileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        }),
      });
      const intent = await intentResponse.json() as {
        assetId?: string;
        uploadUrl?: string;
        requiredHeaders?: Record<string, string>;
        error?: string;
      };
      if (!intentResponse.ok || !intent.assetId || !intent.uploadUrl || !intent.requiredHeaders) {
        throw new UploadPipelineError(intent.error ?? "UPLOAD_INTENT_FAILED", "intent", intentResponse.status);
      }
      assetId = intent.assetId;

      failureStage = "storage_put";
      setStage("uploading");
      let putResponse: Response;
      try {
        putResponse = await fetch(intent.uploadUrl, {
          method: "PUT",
          credentials: "omit",
          body: file,
          headers: intent.requiredHeaders,
        });
      } catch {
        throw new UploadPipelineError("STORAGE_NETWORK_ERROR", "storage_put");
      }
      if (!putResponse.ok) {
        throw new UploadPipelineError(`STORAGE_HTTP_${putResponse.status}`, "storage_put", putResponse.status);
      }

      failureStage = "client_hash";
      setStage("finalizing");
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const finalization = {
        assetId: intent.assetId,
        purposeKey: selected.purpose.key,
        name: name.trim(),
        languageTag,
        sizeBytes: file.size,
        sha256,
        contentType: file.type,
        ...(sourceId ? { sourceId } : {}),
      };

      failureStage = "finalize";
      const finalResponse = await fetch("/app/merchant-knowledge/upload-finalize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalization),
      });
      const finalResult = await finalResponse.json() as { ok?: boolean; error?: string; queued?: boolean };
      if (!finalResponse.ok || !finalResult.ok) {
        throw new UploadPipelineError(finalResult.error ?? "UPLOAD_FINALIZATION_FAILED", "finalize", finalResponse.status);
      }
      setStage("idle");
      setNotice(localized(t, "merchantKnowledge.upload.pending", "Saved for processing"));
      setFile(null);
      if (!sourceId) {
        setName("");
        nameEdited.current = false;
      }
      await revalidator.revalidate();
    } catch (error) {
      const uploadError = error instanceof UploadPipelineError
        ? error
        : new UploadPipelineError(
            failureStage === "storage_put"
              ? "STORAGE_NETWORK_ERROR"
              : failureStage === "client_hash"
                ? "HASH_FAILED"
                : failureStage === "finalize"
                  ? "UPLOAD_FINALIZATION_FAILED"
                  : "UPLOAD_INTENT_FAILED",
            failureStage,
          );

      if (uploadError.stage === "storage_put" || uploadError.stage === "client_hash") {
        void fetch("/app/merchant-knowledge/upload-failure", {
          method: "POST",
          credentials: "same-origin",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stage: uploadError.stage,
            assetId,
            purposeKey: selected.purpose.key,
            dataFormatKey: selected.dataFormat.key,
            sizeBytes: file.size,
            contentType: file.type,
            ...(uploadError.statusCode ? { statusCode: uploadError.statusCode } : {}),
            errorCode: uploadError.code,
          }),
        }).catch(() => {});
      }

      setNotice(null);
      setFailure(`${localized(t, "merchantKnowledge.upload.failed", "Upload failed")} (${uploadError.code})`);
      setStage("failed");
    }
  }

  if (!catalogue.length) return null;

  return (
    <form className="moda-merchant-knowledge-form moda-merchant-knowledge-upload-form" onSubmit={upload}>
      <label className="moda-merchant-knowledge-field">
          {localized(t, "merchantKnowledge.upload.purpose", "Purpose")}
        <select
          value={selected?.purpose.key ?? ""}
          onChange={(event) => setPairIndex(catalogue.findIndex((entry) => entry.purpose.key === event.currentTarget.value))}
          required
        >
          {[...new Map(catalogue.map((entry) => [entry.purpose.key, entry.purpose])).values()].map((purpose) => (
            <option key={purpose.key} value={purpose.key}>
              {localized(t, `merchantKnowledge.purposes.${purpose.key}.label`, purpose.displayName)}
            </option>
          ))}
        </select>
      </label>
      {selected ? (
        <label className="moda-merchant-knowledge-field">
          {localized(t, "merchantKnowledge.upload.dataFormat", "Data format")}
          <select
            value={selected.dataFormat.key}
            onChange={(event) => {
              const nextIndex = catalogue.findIndex((entry) => entry.purpose.key === selected.purpose.key && entry.dataFormat.key === event.currentTarget.value);
              if (nextIndex >= 0) setPairIndex(nextIndex);
            }}
          >
            {[...new Set(catalogue.filter((entry) => entry.purpose.key === selected.purpose.key).map((entry) => entry.dataFormat.key))].map((key) => (
              <option key={key} value={key}>{localized(t, `merchantKnowledge.dataFormats.${key}.label`, catalogue.find((entry) => entry.purpose.key === selected.purpose.key && entry.dataFormat.key === key)?.dataFormat.displayName ?? key)}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="moda-merchant-knowledge-field">
        {localized(t, "merchantKnowledge.upload.sourceName", "Source name")}
        <input
          value={name}
          maxLength={160}
          required
          onChange={(event) => {
            nameEdited.current = true;
            setName(event.currentTarget.value);
          }}
        />
      </label>
      <label className="moda-merchant-knowledge-field moda-merchant-knowledge-field-wide">
        {localized(t, "merchantKnowledge.upload.file", "File")}
        <div
          className={`moda-merchant-knowledge-dropzone${dragActive ? " is-drag-active" : ""}${file ? " has-file" : ""}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            type="file"
            accept={accept}
            aria-required="true"
            disabled={busy}
            onChange={(event) => {
              const acceptedFile = chooseFile(event.currentTarget.files?.[0] ?? null);
              if (!acceptedFile) event.currentTarget.value = "";
            }}
          />
          <span className="moda-merchant-knowledge-selected-file" aria-live="polite">
            {file?.name ?? selectedFormatLabel}
          </span>
        </div>
      </label>
      <p className="moda-merchant-knowledge-help">{localized(t, "merchantKnowledge.upload.maxSize", `Maximum upload size: ${maxUploadBytes} bytes`, { bytes: maxUploadBytes })}</p>
      <label className="moda-merchant-knowledge-field">
        {localized(t, "merchantKnowledge.upload.language", "Language")}
        <select value={languageTag} onChange={(event) => setLanguageTag(event.currentTarget.value)}>
          {supportedLanguageTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </label>
      <button className="moda-merchant-knowledge-primary-action" type="submit" disabled={busy || !file || !name.trim()}>
        {localized(t, `merchantKnowledge.upload.${stage === "idle" ? "submit" : stage}`, {
          idle: "Upload file",
          preparing: "Preparing",
          uploading: "Uploading",
          finalizing: "Finalizing",
          failed: "Failed",
        }[stage])}
      </button>
      {failure ? <p role="alert">{failure}</p> : null}
      {!failure && notice ? <p role="status">{notice}</p> : null}
      {!failure && !notice && stage !== "idle" ? (
        <p role="status">{localized(t, `merchantKnowledge.upload.${stage}`, stage[0]!.toUpperCase() + stage.slice(1))}</p>
      ) : null}
    </form>
  );
}
