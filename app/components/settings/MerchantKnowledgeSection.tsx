import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import type { loader } from "@/routes/app/recovery-settings/route";
import MerchantKnowledgeUploadForm from "./MerchantKnowledgeUploadForm";

type KnowledgeData = Awaited<ReturnType<typeof loader>>["merchantKnowledge"];
type Translate = (key: string, values?: Record<string, string | number>) => string;

export default function MerchantKnowledgeSection({
  data,
  t,
}: {
  data: KnowledgeData;
  t: Translate;
}) {
  const createFetcher = useFetcher();
  const reorderFetcher = useFetcher();
  const refreshFetcher = useFetcher();
  const reprocessFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const revalidator = useRevalidator();
  const busy = [createFetcher, reorderFetcher, refreshFetcher, reprocessFetcher, deleteFetcher].some((fetcher) => fetcher.state !== "idle");
  const [selectedPurpose, setSelectedPurpose] = useState(data.catalogue[0]?.purpose.key ?? "");

  useEffect(() => {
    if ([createFetcher, reorderFetcher, refreshFetcher, reprocessFetcher, deleteFetcher].some((fetcher) => fetcher.data?.ok))
      void revalidator.revalidate();
  }, [createFetcher, reorderFetcher, refreshFetcher, reprocessFetcher, deleteFetcher, revalidator]);

  function submit(fetcher: typeof createFetcher, form: HTMLFormElement) {
    const body = new FormData(form);
    fetcher.submit(body, { method: "post", action: form.action });
  }

  const webCatalogue = data.catalogue.filter((item) => item.dataFormat.key === "WEB_PAGE");
  const uploadCatalogue = data.catalogue.filter((item) => item.dataFormat.key === "CSV" || item.dataFormat.key === "XLSX");
  const purposes = [...new Map(webCatalogue.map((item) => [item.purpose.key, item.purpose])).values()];
  const purposeType = webCatalogue.find((item) => item.purpose.key === selectedPurpose);

  return (
    <section className="moda-recovery-panel" aria-labelledby="merchant-knowledge-heading">
      <div className="moda-recovery-section-heading">
          <h2 id="merchant-knowledge-heading">Merchant Knowledge</h2>
          <p>Configure web pages the assistant can use as reference material.</p>
      </div>

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

          {webCatalogue.length ? (
            <form
              action="/app/merchant-knowledge/source"
              method="post"
              onSubmit={(event) => {
                event.preventDefault();
                submit(createFetcher, event.currentTarget);
              }}
              className="moda-recovery-behaviour-section"
            >
              <input type="hidden" name="operation" value="create" />
              <label>
                  Source name
                <input name="name" maxLength={160} required />
              </label>
              <label>
                  Purpose
                <select name="purposeKey" value={selectedPurpose} onChange={(event) => setSelectedPurpose(event.currentTarget.value)} required>
                  {purposes.map((purpose) => (
                    <option key={purpose.key} value={purpose.key}>{t(`merchantKnowledge.purposes.${purpose.key}.label`)}</option>
                  ))}
                </select>
              </label>
              <label>
                  Data format
                <input type="hidden" name="dataFormatKey" value={purposeType?.dataFormat.key ?? "WEB_PAGE"} />
                <span>{purposeType ? t(`merchantKnowledge.dataFormats.${purposeType.dataFormat.key}.label`) : ""}</span>
              </label>
              <label>
                  URL
                <input name="url" type="url" maxLength={2048} placeholder="https://" required />
              </label>
              <label>
                  Language
                <select name="languageTag" defaultValue={data.defaultLanguageTag} required>
                  {data.supportedLanguageTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                </select>
              </label>
              <button type="submit" disabled={busy || data.planEligibleSourceCount >= data.maxKnowledgeSources}>
                  Add web page
              </button>
            </form>
          ) : (
              <p role="status">No web page source types are available for this plan.</p>
          )}

          {uploadCatalogue.length ? (
            <MerchantKnowledgeUploadForm
              catalogue={uploadCatalogue}
              maxUploadBytes={data.maxUploadBytes}
              defaultLanguageTag={data.defaultLanguageTag}
              supportedLanguageTags={data.supportedLanguageTags}
              t={t}
            />
          ) : null}

          {!data.sources.length ? (
              <p role="status">No knowledge sources configured.</p>
          ) : (
            <ol className="moda-recovery-behaviour-section">
              {data.sources.map((source, index) => (
                <li key={source.id} className="moda-recovery-setting-row">
                  <div>
                    <h3>{source.name}</h3>
                    <p>{t(`merchantKnowledge.purposes.${source.purposeKey}.label`)} · {t(`merchantKnowledge.dataFormats.${source.dataFormatKey}.label`)} · {source.languageTag}</p>
                      <p>{source.uploadedFileName ?? source.revision?.requestedUrl ?? "No URL recorded"}</p>
                    <p>
                      {source.dormantReason
                          ? source.dormantReason.replaceAll("_", " ").toLowerCase()
                          : (source.revision?.status ?? "PENDING").toLowerCase()}
                    </p>
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
                          <button type="submit" disabled={busy || !source.currentlyPlanEntitled}>{t("merchantKnowledge.upload.reprocess")}</button>
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
                        createFetcher.submit(body, { method: "post", action: event.currentTarget.action });
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
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}