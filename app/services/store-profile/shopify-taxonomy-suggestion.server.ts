import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import db from "@/db.server";

export const SHOPIFY_TAXONOMY_PRODUCTS_QUERY = `query ModaStoreCategorySuggestionProducts {
  products(first: 250, sortKey: ID) {
    nodes {
      category {
        id
      }
    }
  }
}`;

type Category = { id: string; displayOrder?: number };
type TaxonomyMapping = {
  id: string;
  categoryId: string;
  shopifyTaxonomyCategoryId: string;
  weight: number;
};
export type StoreCategorySuggestion = {
  categoryId: string;
  matchedMappingIds: string[];
};
type AdminGraphqlClient = {
  graphql(query: string): Promise<{
    ok?: boolean;
    status?: number;
    headers?: {get(name: string): string | null};
    json(): Promise<unknown>;
  }>;
};
type MappingReader = Pick<typeof db, "commerceStoreCategoryTaxonomyMapping">;

const logger = createLogger({serviceName: "moda-interact", environment: resolveDeploymentEnvironmentName()});

export async function readShopifyTaxonomyCategoryIds(admin: AdminGraphqlClient) {
  let stage = "provider_request";
  let origin: "transport" | "provider_response" | "internal" = "transport";
  let httpStatus: number | undefined; let providerRequestId: string | undefined;
  try {
    const response = await admin.graphql(SHOPIFY_TAXONOMY_PRODUCTS_QUERY);
    httpStatus = Number.isInteger(response.status) && response.status! >= 100 && response.status! <= 599 ? response.status : undefined;
    const id = response.headers?.get("x-request-id");
    providerRequestId = id && /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : undefined;
    stage = "response_parse"; origin = "internal";
    const payload = await response.json() as {
      data?: {products?: {nodes?: Array<{category?: {id?: unknown} | null}>}};
      errors?: Array<{message?: unknown; extensions?: {code?: unknown}}>;
    };
    const supplied = Array.isArray(payload?.errors) ? payload.errors.find(error => typeof error?.message === "string") : undefined;
    if (supplied) {
      stage = "provider_errors"; origin = "provider_response";
      const source = new Error(supplied.message as string);
      if (typeof supplied.extensions?.code === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(supplied.extensions.code)) Object.assign(source, {code: supplied.extensions.code});
      throw source;
    }
    stage = response.ok === false ? "http_failure" : "response_shape";
    if (response.ok === false || payload?.errors?.length || !Array.isArray(payload?.data?.products?.nodes)) throw new Error("Shopify taxonomy evidence unavailable");
    return payload.data.products.nodes.flatMap(product => typeof product.category?.id === "string" && product.category.id.length > 0 ? [product.category.id] : []);
  } catch (error) {
    let diagnostic = error;
    if (error instanceof SyntaxError) {
      const quote = error.message.search(/["'{}\r\n]/);
      if (quote >= 0) diagnostic = new SyntaxError(`${error.message.slice(0, quote).trimEnd()} [REDACTED]`);
    }
    logBillingBoundaryFailure({event: "shopify.taxonomy.read_failed", operation: "read_taxonomy_categories", stage, origin,
      error, diagnosticError: diagnostic, redactionApplied: diagnostic !== error,
    }, {...logger, error: (event, fields = {}) => {
      const {databaseCode, ...safe} = fields;
      logger.error(event, {...safe, ...(httpStatus === undefined ? {} : {httpStatus}),
        ...(providerRequestId ? {providerRequestId} : {}), ...(databaseCode ? {providerCode: databaseCode} : {})});
    }});
    throw error;
  }
}

export function scoreStoreCategorySuggestion(
  categories: Category[],
  taxonomyCategoryIds: string[],
  mappings: TaxonomyMapping[],
): StoreCategorySuggestion | null {
  if (!categories.length) return null;
  const selectableIds = new Set(categories.map((category) => category.id));
  const displayOrder = new Map(categories.map((category, index) => [
    category.id,
    category.displayOrder ?? index,
  ]));
  const mappingByTaxonomyId = new Map(
    mappings
      .filter((mapping) => selectableIds.has(mapping.categoryId) && mapping.weight > 0)
      .map((mapping) => [mapping.shopifyTaxonomyCategoryId, mapping]),
  );
  const categoryScores = new Map<string, number>();
  const mappingScores = new Map<string, number>();

  for (const taxonomyId of taxonomyCategoryIds) {
    const mapping = mappingByTaxonomyId.get(taxonomyId);
    if (!mapping) continue;
    categoryScores.set(
      mapping.categoryId,
      (categoryScores.get(mapping.categoryId) ?? 0) + mapping.weight,
    );
    mappingScores.set(mapping.id, (mappingScores.get(mapping.id) ?? 0) + mapping.weight);
  }

  const winner = [...categories].sort((left, right) =>
    (categoryScores.get(right.id) ?? 0) - (categoryScores.get(left.id) ?? 0) ||
    (displayOrder.get(left.id) ?? 0) - (displayOrder.get(right.id) ?? 0) ||
    left.id.localeCompare(right.id, "en"),
  )[0];

  const matchedMappingIds = mappings
    .filter((mapping) => mapping.categoryId === winner.id && (mappingScores.get(mapping.id) ?? 0) > 0)
    .sort((left, right) =>
      (mappingScores.get(right.id) ?? 0) - (mappingScores.get(left.id) ?? 0) ||
      left.id.localeCompare(right.id, "en"),
    )
    .map((mapping) => mapping.id);

  return {
    categoryId: winner.id,
    matchedMappingIds,
  };
}

export async function suggestStoreCategory(
  admin: AdminGraphqlClient,
  categories: Category[],
  client: MappingReader = db,
): Promise<StoreCategorySuggestion | null> {
  if (!categories.length) return null;
  let stage = "taxonomy_read";
  try {
    const taxonomyCategoryIds = await readShopifyTaxonomyCategoryIds(admin);
    stage = "mapping_read";
    const mappings = await client.commerceStoreCategoryTaxonomyMapping.findMany({
      where: {
        categoryId: { in: categories.map((category) => category.id) },
        shopifyTaxonomyCategoryId: { in: [...new Set(taxonomyCategoryIds)] },
        weight: { gt: 0 },
        conditionKey: { not: null },
      },
      select: { id: true, categoryId: true, shopifyTaxonomyCategoryId: true, weight: true },
    });
    return scoreStoreCategorySuggestion(categories, taxonomyCategoryIds, mappings);
  } catch (error) {
    logBillingBoundaryFailure({event: "shopify.taxonomy.suggestion_failed", operation: "suggest_store_category", stage,
      origin: stage === "mapping_read" ? "database" : "internal", error});
    return {
      categoryId: categories[0].id,
      matchedMappingIds: [],
    };
  }
}
