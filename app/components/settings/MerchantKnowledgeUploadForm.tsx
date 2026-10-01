import { useState } from "react";
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
type Stage = "idle" | "preparing" | "uploading" | "finalizing" | "queued" | "pending" | "failed";

function contentTypes(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function localized(t: Translate, key: string, fallback: string, values?: Record<string, string | number>): string {
  const result = t(key, values);
  return result === key ? fallback : result;
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
  const [pairIndex, setPairIndex] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(initialName ?? "");
  const [languageTag, setLanguageTag] = useState(initialLanguageTag ?? defaultLanguageTag);
  const [stage, setStage] = useState<Stage>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const selected = catalogue[pairIndex];
  const accepted = selected ? contentTypes(selected.dataFormat.acceptedContentTypes) : [];
  const accept = selected
    ? [selected.dataFormat.canonicalExtension, ...accepted].filter(Boolean).join(",")
    : "";
  const busy = stage === "preparing" || stage === "uploading" || stage === "finalizing";

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !selected || busy) return;
    setFailure(null);
    const extension = selected.dataFormat.canonicalExtension?.toLowerCase();
    const fileType = file.type.split(";", 1)[0]!.trim().toLowerCase();
    if (
      file.size <= 0 || file.size > maxUploadBytes || !extension
      || !file.name.toLowerCase().endsWith(extension)
      || !accepted.some((candidate) => candidate.split(";", 1)[0]!.trim().toLowerCase() === fileType)
    ) {
      setFailure(localized(t, "merchantKnowledge.upload.failed", "Upload failed"));
      setStage("failed");
      return;
    }

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
        throw new Error(intent.error ?? "UPLOAD_INTENT_FAILED");
      }

      setStage("uploading");
      const putResponse = await fetch(intent.uploadUrl, {
        method: "PUT",
        credentials: "omit",
        body: file,
        headers: intent.requiredHeaders,
      });
      if (!putResponse.ok) throw new Error("UPLOAD_FAILED");

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
      const finalResponse = await fetch("/app/merchant-knowledge/upload-finalize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalization),
      });
      const finalResult = await finalResponse.json() as { ok?: boolean; error?: string; queued?: boolean };
      if (!finalResponse.ok || !finalResult.ok) throw new Error(finalResult.error ?? "UPLOAD_FINALIZATION_FAILED");
      setStage(finalResult.queued ? "queued" : "pending");
      setFile(null);
      if (!sourceId) setName("");
      await revalidator.revalidate();
    } catch (error) {
      setFailure(localized(t, "merchantKnowledge.upload.failed", "Upload failed"));
      setStage("failed");
    }
  }

  if (!catalogue.length) return null;

  return (
    <form className="moda-recovery-behaviour-section" onSubmit={upload}>
      <label>
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
        <label>
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
      <label>
        {localized(t, "merchantKnowledge.upload.sourceName", "Source name")}
        <input value={name} maxLength={160} required onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      <label>
        {localized(t, "merchantKnowledge.upload.file", "File")}
        <input
          type="file"
          accept={accept}
          required
          onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
        />
      </label>
      <p>{localized(t, "merchantKnowledge.upload.maxSize", `Maximum upload size: ${maxUploadBytes} bytes`, { bytes: maxUploadBytes })}</p>
      <label>
        {localized(t, "merchantKnowledge.upload.language", "Language")}
        <select value={languageTag} onChange={(event) => setLanguageTag(event.currentTarget.value)}>
          {supportedLanguageTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </label>
      <button type="submit" disabled={busy || !file || !name.trim()}>
        {localized(t, `merchantKnowledge.upload.${stage === "idle" ? "submit" : stage}`, {
          idle: "Upload file",
          preparing: "Preparing",
          uploading: "Uploading",
          finalizing: "Finalizing",
          queued: "Queued",
          pending: "Saved for processing",
          failed: "Failed",
        }[stage])}
      </button>
      {stage !== "idle" ? <p role={stage === "failed" ? "alert" : "status"}>{failure ?? localized(t, `merchantKnowledge.upload.${stage}`, stage[0]!.toUpperCase() + stage.slice(1))}</p> : null}
    </form>
  );
}