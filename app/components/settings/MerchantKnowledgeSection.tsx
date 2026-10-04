import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import type { loader } from "@/routes/app/recovery-settings/route";
import MerchantKnowledgeUploadForm from "./MerchantKnowledgeUploadForm";

type KnowledgeData = Awaited<ReturnType<typeof loader>>["merchantKnowledge"];
type Translate = (key: string, values?: Record<string, string | number>) => string;

type KnowledgeSource = KnowledgeData["sources"][number];
type SourceStatusTone = "processing" | "ready" | "failed" | "paused" | "inactive";

function merchantKnowledgeSourceStatus(source: KnowledgeSource): { label: string; tone: SourceStatusTone; detail?: string } {
  if (source.dormantReason === "MERCHANT_DISABLED") {
    return { label: "Configured — processing paused", tone: "paused" };
  }
  if (source.dormantReason === "NO_CURRENT_PLAN") {
    return { label: "Configured — unavailable on current plan", tone: "inactive" };
  }
  if (source.dormantReason === "SOURCE_TYPE") {
    return { label: "Configured — source type unavailable", tone: "inactive" };
  }
  if (source.dormantReason === "SOURCE_COUNT") {
    return { label: "Configured — over current source limit", tone: "inactive" };
  }

  switch (source.revision?.status) {
    case "ACTIVE":
      return { label: "Ready", tone: "ready" };
    case "FAILED":
      return {
        label: "Processing failed",
        tone: "failed",
        detail: source.revision.failureCode
          ? source.revision.failureCode.replaceAll("_", " ").toLowerCase()
          : undefined,
      };
    case "SUPERSEDED":
      return { label: "Superseded", tone: "inactive" };
    case "PROCESSING":
    case "PENDING":
    default:
      return { label: "Processing", tone: "processing" };
  }
}

export default function MerchantKnowledgeSection({
  data,
  t,
  embedded = false,
}: {
  data: KnowledgeData;
  t: Translate;
  embedded?: boolean;
}) {
  const createFetcher = useFetcher();
  const reorderFetcher = useFetcher();
  const refreshFetcher = useFetcher();
  const reprocessFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const revalidator = useRevalidator();
  const busy = [createFetcher, reorderFetcher, refreshFetcher, reprocessFetcher, deleteFetcher].some((fetcher) => fetcher.state !== "idle");
  const [selectedPurpose, setSelectedPurpose] = useState(data.catalogue[0]?.purpose.key ?? "");
  const hasProcessingSources = data.sources.some((source) =>
    source.processingEligible && (source.revision?.status === "PENDING" || source.revision?.status === "PROCESSING"),
  );

  useEffect(() => {
    if ([createFetcher, reorderFetcher, refreshFetcher, reprocessFetcher, deleteFetcher].some((fetcher) => fetcher.data?.ok))
      void revalidator.revalidate();
  }, [createFetcher, reorderFetcher, refreshFetcher, reprocessFetcher, deleteFetcher, revalidator]);

  useEffect(() => {
    if (!hasProcessingSources) return;

    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void revalidator.revalidate();
    }, 4_000);
    const timeout = window.setTimeout(() => window.clearInterval(interval), 60_000);

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [hasProcessingSources, revalidator]);

  function formAction(form: HTMLFormElement): string | undefined {
    const action = form.getAttribute("action");
    return action?.trim() || undefined;
  }

  function submit(fetcher: typeof createFetcher, form: HTMLFormElement) {
    const body = new FormData(form);
    fetcher.submit(body, { method: "post", action: formAction(form) });
  }

  const webCatalogue = data.catalogue.filter((item) => item.dataFormat.key === "WEB_PAGE");
  const uploadCatalogue = data.catalogue.filter((item) => item.dataFormat.key === "CSV" || item.dataFormat.key === "XLSX");
  const purposes = [...new Map(webCatalogue.map((item) => [item.purpose.key, item.purpose])).values()];
  const purposeType = webCatalogue.find((item) => item.purpose.key === selectedPurpose);

  return (
    <section
      className={embedded
        ? "moda-merchant-knowledge-panel moda-recovery-embedded-panel"
        : "moda-recovery-panel moda-merchant-knowledge-panel"}
      aria-labelledby={embedded ? undefined : "merchant-knowledge-heading"}
      aria-label={embedded ? "Merchant Knowledge" : undefined}
    >
      {!embedded ? (
        <div className="moda-recovery-section-heading">
          <h2 id="merchant-knowledge-heading">Merchant Knowledge</h2>
          <p>Configure web pages the assistant can use as reference material.</p>
        </div>
      ) : null}

      {!data.planEntitled ? (
          <p role="status">Merchant Knowledge configuration is unavailable on the current plan.</p>
      ) : (
        <>
          {!data.merchantEnabled ? (
            <p className="moda-recovery-inline-message" role="status">
                Ingestion and retrieval are disabled until Merchant Knowledge is enabled in Conversation Features. Configured sources are retained.
            </p>
          ) : null}

          <p className="moda-recovery-effective-value">
              {data.configuredCount} of {data.maxKnowledgeSources} sources configured
          </p>

          <div className="moda-merchant-knowledge-add-grid">
            {webCatalogue.length ? (
              <details className="moda-settings-disclosure moda-merchant-knowledge-add">
                <summary>
                  <span>Add web page</span>
                  <small>
                    {purposeType ? t(`merchantKnowledge.dataFormats.${purposeType.dataFormat.key}.label`) : ""}
                  </small>
                </summary>
                <div className="moda-settings-disclosure-body">
                  <form
                    action="/app/merchant-knowledge/source"
                    method="post"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submit(createFetcher, event.currentTarget);
                    }}
                    className="moda-merchant-knowledge-form moda-merchant-knowledge-web-form"
                  >
                    <input type="hidden" name="operation" value="create" />
                    <label className="moda-merchant-knowledge-field">
                        Source name
                      <input name="name" maxLength={160} required />
                    </label>
                    <label className="moda-merchant-knowledge-field">
                        Purpose
                      <select name="purposeKey" value={selectedPurpose} onChange={(event) => setSelectedPurpose(event.currentTarget.value)} required>
                        {purposes.map((purpose) => (
                          <option key={purpose.key} value={purpose.key}>{t(`merchantKnowledge.purposes.${purpose.key}.label`)}</option>
                        ))}
                      </select>
                    </label>
                    <label className="moda-merchant-knowledge-field">
                        Data format
                      <input type="hidden" name="dataFormatKey" value={purposeType?.dataFormat.key ?? "WEB_PAGE"} />
                      <span className="moda-merchant-knowledge-readonly">{purposeType ? t(`merchantKnowledge.dataFormats.${purposeType.dataFormat.key}.label`) : ""}</span>
                    </label>
                    <label className="moda-merchant-knowledge-field">
                        URL
                      <input name="url" type="url" maxLength={2048} placeholder="https://" required />
                    </label>
                    <label className="moda-merchant-knowledge-field">
                        Language
                      <select name="languageTag" defaultValue={data.defaultLanguageTag} required>
                        {data.supportedLanguageTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                      </select>
                    </label>
                    <button className="moda-merchant-knowledge-primary-action" type="submit" disabled={busy || data.planEligibleSourceCount >= data.maxKnowledgeSources}>
                        Add web page
                    </button>
                  </form>
                </div>
              </details>
            ) : (
                <p role="status">No web page source types are available for this plan.</p>
            )}

            {uploadCatalogue.length ? (
              <details className="moda-settings-disclosure moda-merchant-knowledge-add">
                <summary>
                  <span>{t("merchantKnowledge.upload.submit")}</span>
                  <small>
                    {[...new Set(uploadCatalogue.map((item) => item.dataFormat.key))]
                      .map((key) => t(`merchantKnowledge.dataFormats.${key}.label`))
                      .join(" / ")}
                  </small>
                </summary>
                <div className="moda-settings-disclosure-body">
                  <MerchantKnowledgeUploadForm
                    catalogue={uploadCatalogue}
                    maxUploadBytes={data.maxUploadBytes}
                    defaultLanguageTag={data.defaultLanguageTag}
                    supportedLanguageTags={data.supportedLanguageTags}
                    t={t}
                  />
                </div>
              </details>
            ) : null}
          </div>

          {!data.sources.length ? (
              <p role="status">No knowledge sources configured.</p>
          ) : (
            <ol className="moda-recovery-behaviour-section moda-merchant-knowledge-source-list">
              {data.sources.map((source, index) => {
                const status = merchantKnowledgeSourceStatus(source);
                return (
                <li key={source.id} className="moda-recovery-setting-row moda-merchant-knowledge-source-card">
                  <div className="moda-merchant-knowledge-source-copy">
                    <h3>{source.name}</h3>
                    <p>{t(`merchantKnowledge.purposes.${source.purposeKey}.label`)} · {t(`merchantKnowledge.dataFormats.${source.dataFormatKey}.label`)} · {source.languageTag}</p>
                    <p>{source.uploadedFileName ?? source.revision?.requestedUrl ?? "No URL recorded"}</p>
                    <p className={`moda-merchant-knowledge-source-status is-${status.tone}`}>
                      <strong>{status.label}</strong>{status.detail ? ` · ${status.detail}` : ""}
                    </p>
                    {status.tone === "processing" ? (
                      <p className="moda-merchant-knowledge-processing-note">This page updates automatically while the source is processing.</p>
                    ) : null}
                    {source.revision?.activeContentUnits !== null && source.revision?.activeContentUnits !== undefined ? (
                      <p>{source.revision.activeContentUnits} active content units{source.revision.activeTruncated ? " · truncated" : ""}</p>
                    ) : null}
                    {source.revision?.activeFetchedAt ? <p>Last processed {new Date(source.revision.activeFetchedAt).toLocaleString()}</p> : null}
                  </div>
                  <div className="moda-recovery-setting-actions">
                    <button type="button" disabled={busy || index === 0} onClick={() => {
                      const ids = data.sources.map(({ id }) => id);
                      [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                      reorderFetcher.submit({ sourceIds: JSON.stringify(ids) }, { method: "post", action: "/app/merchant-knowledge/reorder" });
                    }} aria-label="Move source up" title="Move source up">↑</button>
                    <button type="button" disabled={busy || index === data.sources.length - 1} onClick={() => {
                      const ids = data.sources.map(({ id }) => id);
                      [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
                      reorderFetcher.submit({ sourceIds: JSON.stringify(ids) }, { method: "post", action: "/app/merchant-knowledge/reorder" });
                    }} aria-label="Move source down" title="Move source down">↓</button>
                    <form action="/app/merchant-knowledge/refresh" method="post" onSubmit={(event) => {
                      event.preventDefault();
                      submit(refreshFetcher, event.currentTarget);
                    }}>
                      <input type="hidden" name="sourceId" value={source.id} />
                      <button type="submit" disabled={busy || source.dataFormatKey !== "WEB_PAGE"}>Refresh</button>
                    </form>
                    {source.dataFormatKey === "CSV" || source.dataFormatKey === "XLSX" ? (
                      <>
                        <form action="/app/merchant-knowledge/reprocess" method="post" onSubmit={(event) => {
                          event.preventDefault();
                          submit(reprocessFetcher, event.currentTarget);
                        }}>
                          <input type="hidden" name="sourceId" value={source.id} />
                          <button
                            type="submit"
                            disabled={busy || !source.currentlyPlanEntitled || source.revision?.status === "PENDING" || source.revision?.status === "PROCESSING"}
                          >
                            {t("merchantKnowledge.upload.reprocess")}
                          </button>
                        </form>
                        <details>
                          <summary>{t("merchantKnowledge.upload.replaceFile")}</summary>
                          <MerchantKnowledgeUploadForm
                            catalogue={uploadCatalogue.filter((item) => item.purpose.key === source.purposeKey && item.dataFormat.key === source.dataFormatKey)}
                            maxUploadBytes={data.maxUploadBytes}
                            defaultLanguageTag={data.defaultLanguageTag}
                            supportedLanguageTags={data.supportedLanguageTags}
                            sourceId={source.id}
                            initialName={source.name}
                            initialLanguageTag={source.languageTag}
                            t={t}
                          />
                        </details>
                      </>
                    ) : null}
                    <details>
                      <summary>{t("merchantKnowledge.upload.edit")}</summary>
                      <form action="/app/merchant-knowledge/source" method="post" onSubmit={(event) => {
                        event.preventDefault();
                        const body = new FormData(event.currentTarget);
                        body.set("operation", source.dataFormatKey === "WEB_PAGE" ? "edit" : "edit-upload");
                        createFetcher.submit(body, { method: "post", action: formAction(event.currentTarget) });
                      }}>
                        <input type="hidden" name="operation" value="edit" />
                        <input type="hidden" name="sourceId" value={source.id} />
                        <label>{t("merchantKnowledge.upload.sourceName")}<input name="name" maxLength={160} defaultValue={source.name} required /></label>
                        {source.dataFormatKey === "WEB_PAGE" ? <label>URL<input name="url" type="url" maxLength={2048} defaultValue={source.revision?.requestedUrl ?? ""} required /></label> : null}
                        <label>{t("merchantKnowledge.upload.language")}<select name="languageTag" defaultValue={source.languageTag}>{data.supportedLanguageTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
                        <button type="submit" disabled={busy || !source.currentlyPlanEntitled}>{t("merchantKnowledge.upload.save")}</button>
                      </form>
                    </details>
                    <form action="/app/merchant-knowledge/delete" method="post" onSubmit={(event) => {
                      event.preventDefault();
                      submit(deleteFetcher, event.currentTarget);
                    }}>
                      <input type="hidden" name="sourceId" value={source.id} />
                      <button type="submit" disabled={busy}>Delete</button>
                    </form>
                  </div>
                </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </section>
  );
}