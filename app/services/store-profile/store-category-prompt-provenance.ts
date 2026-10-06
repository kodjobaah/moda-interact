export const STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_SCHEMA_VERSION = 1 as const;
export const STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_KIND = "STORE_CATEGORY_SELECTION" as const;

type StoreCategoryPromptSourceContextInput = {
  category: { id: string; editVersion: number };
  template: { id: string; editVersion: number };
  mappings: ReadonlyArray<{ id: string; editVersion: number; conditionKey: string }>;
};

export type StoreCategoryPromptSourceContext = {
  schemaVersion: typeof STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_SCHEMA_VERSION;
  kind: typeof STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_KIND;
  categoryId: string;
  categoryEditVersion: number;
  templateId: string;
  templateEditVersion: number;
  mappings: Array<{
    mappingId: string;
    mappingEditVersion: number;
    conditionKey: string;
  }>;
};

export function createStoreCategoryPromptSourceContext(
  input: StoreCategoryPromptSourceContextInput,
): StoreCategoryPromptSourceContext {
  return {
    schemaVersion: STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_SCHEMA_VERSION,
    kind: STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_KIND,
    categoryId: input.category.id,
    categoryEditVersion: input.category.editVersion,
    templateId: input.template.id,
    templateEditVersion: input.template.editVersion,
    mappings: [...input.mappings]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((mapping) => ({
        mappingId: mapping.id,
        mappingEditVersion: mapping.editVersion,
        conditionKey: mapping.conditionKey,
      })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readStoreCategoryPromptSourceContext(value: unknown): StoreCategoryPromptSourceContext | null {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_SCHEMA_VERSION ||
    value.kind !== STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_KIND ||
    typeof value.categoryId !== "string" ||
    typeof value.categoryEditVersion !== "number" ||
    !Number.isSafeInteger(value.categoryEditVersion) ||
    typeof value.templateId !== "string" ||
    typeof value.templateEditVersion !== "number" ||
    !Number.isSafeInteger(value.templateEditVersion) ||
    !Array.isArray(value.mappings)
  ) return null;

  const mappings: StoreCategoryPromptSourceContext["mappings"] = [];
  for (const entry of value.mappings) {
    if (
      !isRecord(entry) ||
      typeof entry.mappingId !== "string" ||
      !entry.mappingId ||
      typeof entry.mappingEditVersion !== "number" ||
      !Number.isSafeInteger(entry.mappingEditVersion) ||
      typeof entry.conditionKey !== "string" ||
      !entry.conditionKey
    ) return null;
    mappings.push({
      mappingId: entry.mappingId,
      mappingEditVersion: entry.mappingEditVersion as number,
      conditionKey: entry.conditionKey,
    });
  }

  return {
    schemaVersion: STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_SCHEMA_VERSION,
    kind: STORE_CATEGORY_SELECTION_SOURCE_CONTEXT_KIND,
    categoryId: value.categoryId,
    categoryEditVersion: value.categoryEditVersion as number,
    templateId: value.templateId,
    templateEditVersion: value.templateEditVersion as number,
    mappings,
  };
}
