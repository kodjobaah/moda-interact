import {createMemoryRouter, useLoaderData} from "react-router";
import MerchantKnowledgeSection from "../../app/components/settings/MerchantKnowledgeSection";
export function knowledgeRouterData() {
 const source = (id: string, format: string) => ({id, name: id, purposeKey: format === "WEB_PAGE" ? "FAQ" : "PRODUCT_INFORMATION", purposeDisplayName: "Fixture", dataFormatKey: format, dataFormatDisplayName: format,
  uploadedFileName: null, languageTag: "en", position: 0, currentGeneration: 1, currentlyPlanEntitled: true, processingEligible: true, dormantReason: null,
  revision: {id: `${id}-revision`, generation: 1, reason: "CREATE", status: "ACTIVE", requestedUrl: format === "WEB_PAGE" ? "https://example.test/page" : null, resolvedUrl: null,
   contentUnits: null, truncated: false, fetchedAt: null, completedAt: null, failureCode: null, activeContentUnits: null, activeTruncated: false, activeFetchedAt: null}});
 return {entitlementState: "entitled", planEntitled: true, merchantEnabled: true, effectiveEnabled: true, maxKnowledgeSources: 5, maxUploadBytes: 1000,
  configuredCount: 2, planEligibleSourceCount: 2, defaultLanguageTag: "en", supportedLanguageTags: ["en"],
  catalogue: [{purpose: {key: "FAQ", displayName: "FAQ"}, dataFormat: {key: "WEB_PAGE", displayName: "Web", inputKind: "REMOTE_URL", canonicalExtension: null, acceptedContentTypes: []}},
   {purpose: {key: "PRODUCT_INFORMATION", displayName: "Products"}, dataFormat: {key: "CSV", displayName: "CSV", inputKind: "UPLOAD", canonicalExtension: ".csv", acceptedContentTypes: ["text/csv"]}}],
  sources: [source("web", "WEB_PAGE"), source("csv", "CSV")] } as unknown as Parameters<typeof MerchantKnowledgeSection>[0]["data"];
}
function Page() { return <MerchantKnowledgeSection data={useLoaderData()} t={key => key} formatDateTime={String} />; }
export function knowledgeRouter(loader: () => unknown | Promise<unknown>, action: () => unknown | Promise<unknown>) {
 return createMemoryRouter([{path: "/app/recovery-settings", loader, Component: Page},
  ...["source", "refresh", "reprocess", "reorder", "delete"].map(operation => ({path: `/app/merchant-knowledge/${operation}`, action}))], {initialEntries: ["/app/recovery-settings"]});
}
