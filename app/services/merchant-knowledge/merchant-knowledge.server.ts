import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MerchantKnowledgeDataFormatKeySchema,
  MerchantKnowledgePurposeKeySchema,
} from "@modainteract/moda-interact-shared/merchant-knowledge";
import {
  MODA_SUPPORTED_LANGUAGE_TAGS,
  ModaSupportedLanguageTagSchema,
  resolveModaConfigurationLocale,
} from "@modainteract/moda-interact-shared/internationalization";
import db from "@/db.server";
import { loadCurrentMerchantKnowledgeEntitlement } from "./merchant-knowledge-entitlement.server";
import { enqueueMerchantKnowledgeRevisionBestEffort } from "./merchant-knowledge-queue.server";

type Database = Pick<PrismaClient, "$transaction" | "merchantKnowledgePurpose" | "merchantKnowledgeDataFormat" | "merchantKnowledgePurposeDataFormat" | "merchantKnowledgeSource" | "merchantKnowledgeSourceRevision" | "subscription" | "feature" | "shopFeaturePreference" | "shopSettings">;
type Transaction = Prisma.TransactionClient;

export class MerchantKnowledgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MerchantKnowledgeError";
  }
}

const denied = () => new MerchantKnowledgeError("DENIED");
const invalid = () => new MerchantKnowledgeError("INVALID_INPUT");
const conflict = () => new MerchantKnowledgeError("CONFLICT");

type Activation = {
  featureId: string | null;
  merchantEnabled: boolean;
};

async function readActivation(
  shopId: string,
  database: Pick<PrismaClient, "feature" | "shopFeaturePreference">,
): Promise<Activation> {
  const feature = await database.feature.findUnique({
    where: { key: "merchant_knowledge" },
    select: { id: true, active: true, activationMode: true },
  });
  if (!feature || !feature.active || feature.activationMode !== "MERCHANT_OPT_IN") {
    return { featureId: feature?.id ?? null, merchantEnabled: false };
  }
  const preference = await database.shopFeaturePreference.findUnique({
    where: { shopId_featureId: { shopId, featureId: feature.id } },
    select: { enabled: true },
  });
  return { featureId: feature.id, merchantEnabled: preference?.enabled === true };
}

function parsePublicHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:" || url.username || url.password) throw invalid();
  const canonical = url.toString();
  if (canonical.length > 2048) throw invalid();
  return canonical;
}

function parseLanguageTag(value: unknown, defaultLanguageTag: string | null): string {
  const candidate = value === undefined || value === null || value === ""
    ? resolveModaConfigurationLocale(defaultLanguageTag)
    : value;
  const parsed = ModaSupportedLanguageTagSchema.safeParse(candidate);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function parseSourceType(purposeKey: unknown, dataFormatKey: unknown) {
  const purpose = MerchantKnowledgePurposeKeySchema.safeParse(purposeKey);
  const dataFormat = MerchantKnowledgeDataFormatKeySchema.safeParse(dataFormatKey);
  if (!purpose.success || !dataFormat.success || dataFormat.data !== "WEB_PAGE")
    throw invalid();
  return { purposeKey: purpose.data, dataFormatKey: dataFormat.data };
}

async function lockShop(shopId: string, transaction: Transaction): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "commerce"."Shop"
    WHERE "id" = ${shopId} AND "status" = 'ACTIVE'
    FOR UPDATE
  `);
  if (!rows.length) throw denied();
}

async function loadSourcePair(source: { purposeId: string; dataFormatId: string }, transaction: Transaction) {
  return transaction.merchantKnowledgePurposeDataFormat.findUnique({
    where: {
      purposeId_dataFormatId: {
        purposeId: source.purposeId,
        dataFormatId: source.dataFormatId,
      },
    },
    select: {
      purpose: { select: { id: true, key: true, displayName: true, active: true } },
      dataFormat: { select: { id: true, key: true, displayName: true, active: true, inputKind: true } },
    },
  });
}

export async function loadMerchantKnowledge(shopId: string, database: Database = db) {
  const [entitlement, settings, catalogue, sources] = await Promise.all([
    loadCurrentMerchantKnowledgeEntitlement(shopId, database),
    database.shopSettings.findUnique({
      where: { shopId },
      select: { defaultLanguageTag: true },
    }),
    database.merchantKnowledgePurposeDataFormat.findMany({
      where: {
        purpose: { active: true },
        dataFormat: { active: true, key: "WEB_PAGE", inputKind: "REMOTE_URL" },
      },
      orderBy: [
        { purpose: { displayOrder: "asc" } },
        { purpose: { key: "asc" } },
        { dataFormat: { displayOrder: "asc" } },
        { dataFormat: { key: "asc" } },
      ],
      select: {
        purpose: { select: { key: true, displayName: true } },
        dataFormat: { select: { key: true, displayName: true } },
      },
    }),
    database.merchantKnowledgeSource.findMany({
      where: { shopId },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      include: {
        purpose: { select: { key: true, displayName: true, active: true } },
        dataFormat: { select: { key: true, displayName: true, active: true } },
        revisions: {
          orderBy: [{ generation: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            id: true,
            generation: true,
            reason: true,
            status: true,
            requestedUrl: true,
            resolvedUrl: true,
            contentUnits: true,
            truncated: true,
            fetchedAt: true,
            completedAt: true,
            failureCode: true,
          },
        },
      },
    }),
  ]);
  const activation = await readActivation(shopId, database);
  const activeRevisions = sources.length
    ? await database.merchantKnowledgeSourceRevision.findMany({
        where: { sourceId: { in: sources.map(({ id }) => id) }, status: "ACTIVE" },
        orderBy: [{ generation: "desc" }, { id: "desc" }],
        select: { id: true, sourceId: true, contentUnits: true, truncated: true, fetchedAt: true },
      })
    : [];
  const activeRevisionBySource = new Map(activeRevisions.map((revision) => [revision.sourceId, revision]));
  const planEntitled = entitlement.kind === "entitled";
  const allowed = new Set(
    entitlement.kind === "entitled"
      ? entitlement.configuration.allowedSourceTypes.map(({ purposeKey, dataFormatKey }) => `${purposeKey}\u0000${dataFormatKey}`)
      : [],
  );
  const allowedCatalogue = catalogue.filter(({ purpose, dataFormat }) =>
    dataFormat.key === "WEB_PAGE" &&
    allowed.has(`${purpose.key}\u0000${dataFormat.key}`),
  );
  const typeEligible = sources.filter((source) =>
    source.purpose.active && source.dataFormat.active &&
    allowed.has(`${source.purpose.key}\u0000${source.dataFormat.key}`),
  );
  const maxKnowledgeSources = entitlement.kind === "entitled"
    ? entitlement.configuration.maxKnowledgeSources
    : 0;
  const withinCount = new Set(typeEligible.slice(0, maxKnowledgeSources).map(({ id }) => id));

  return {
    planEntitled,
    merchantEnabled: activation.merchantEnabled,
    effectiveEnabled: planEntitled && activation.merchantEnabled,
    maxKnowledgeSources,
    configuredCount: sources.length,
    planEligibleSourceCount: typeEligible.length,
    defaultLanguageTag: resolveModaConfigurationLocale(settings?.defaultLanguageTag),
    supportedLanguageTags: MODA_SUPPORTED_LANGUAGE_TAGS,
    catalogue: allowedCatalogue,
    sources: sources.map((source) => {
      const currentlyPlanEntitled = source.purpose.active && source.dataFormat.active &&
        allowed.has(`${source.purpose.key}\u0000${source.dataFormat.key}`) && withinCount.has(source.id);
      const dormantReason = !planEntitled
        ? "NO_CURRENT_PLAN"
        : !allowed.has(`${source.purpose.key}\u0000${source.dataFormat.key}`) || !source.purpose.active || !source.dataFormat.active
          ? "SOURCE_TYPE"
          : !withinCount.has(source.id)
            ? "SOURCE_COUNT"
            : !activation.merchantEnabled ? "MERCHANT_DISABLED" : null;
      const revision = source.revisions[0] ?? null;
      const activeRevision = activeRevisionBySource.get(source.id) ?? null;
      return {
        id: source.id,
        name: source.name,
        purposeKey: source.purpose.key,
        purposeDisplayName: source.purpose.displayName,
        dataFormatKey: source.dataFormat.key,
        dataFormatDisplayName: source.dataFormat.displayName,
        languageTag: source.languageTag,
        position: source.position,
        currentGeneration: source.currentGeneration,
        currentlyPlanEntitled,
        processingEligible: currentlyPlanEntitled && activation.merchantEnabled,
        dormantReason,
        revision: revision ? {
          id: revision.id,
          generation: revision.generation,
          reason: revision.reason,
          status: revision.status,
          requestedUrl: revision.requestedUrl,
          resolvedUrl: revision.resolvedUrl,
          contentUnits: revision.contentUnits,
          truncated: revision.truncated,
          fetchedAt: revision.fetchedAt?.toISOString() ?? null,
          completedAt: revision.completedAt?.toISOString() ?? null,
          failureCode: revision.failureCode,
          activeContentUnits: activeRevision?.contentUnits ?? null,
          activeTruncated: activeRevision?.truncated ?? false,
          activeFetchedAt: activeRevision?.fetchedAt?.toISOString() ?? null,
        } : null,
      };
    }),
  };
}

async function requireAllowedPair(
  transaction: Transaction,
  configuration: { allowedSourceTypes: readonly { purposeKey: string; dataFormatKey: string }[] },
  type: { purposeKey: string; dataFormatKey: string },
) {
  if (!configuration.allowedSourceTypes.some((allowed) =>
    allowed.purposeKey === type.purposeKey && allowed.dataFormatKey === type.dataFormatKey,
  )) throw denied();
  const pair = await transaction.merchantKnowledgePurposeDataFormat.findFirst({
    where: {
      purpose: { key: type.purposeKey, active: true },
      dataFormat: { key: type.dataFormatKey, active: true, inputKind: "REMOTE_URL" },
    },
    select: { purposeId: true, dataFormatId: true },
  });
  if (!pair) throw denied();
  return pair;
}

async function requireCurrentlyPlanEntitledSource(
  transaction: Transaction,
  shopId: string,
  sourceId: string,
  configuration: {
    maxKnowledgeSources: number;
    allowedSourceTypes: readonly { purposeKey: string; dataFormatKey: string }[];
  },
): Promise<void> {
  const allowed = new Set(configuration.allowedSourceTypes.map(({ purposeKey, dataFormatKey }) =>
    `${purposeKey}\u0000${dataFormatKey}`,
  ));
  const sources = await transaction.merchantKnowledgeSource.findMany({
    where: { shopId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      purpose: { select: { key: true, active: true } },
      dataFormat: { select: { key: true, active: true } },
    },
  });
  const eligible = sources.filter((source) =>
    source.purpose.active && source.dataFormat.active &&
    allowed.has(`${source.purpose.key}\u0000${source.dataFormat.key}`),
  );
  if (!eligible.slice(0, configuration.maxKnowledgeSources).some(({ id }) => id === sourceId))
    throw denied();
}

async function createRevision(
  transaction: Transaction,
  input: { sourceId: string; shopId: string; generation: number; reason: "CREATE" | "URL_CHANGE" | "REFRESH"; requestedUrl: string },
) {
  const requestedAt = new Date();
  const sourceRevisionId = randomUUID();
  await transaction.merchantKnowledgeSourceRevision.create({
    data: {
      id: sourceRevisionId,
      sourceId: input.sourceId,
      generation: input.generation,
      reason: input.reason,
      requestedUrl: input.requestedUrl,
      status: "PENDING",
      requestedAt,
    },
  });
  return {
    shopId: input.shopId,
    sourceRevisionId,
    generation: input.generation,
    requestedAt,
  };
}

async function enqueueIfEnabled(
  revision: Awaited<ReturnType<typeof createRevision>> | null,
  merchantEnabled: boolean,
  queue?: Parameters<typeof enqueueMerchantKnowledgeRevisionBestEffort>[1],
) {
  if (revision && merchantEnabled)
    await enqueueMerchantKnowledgeRevisionBestEffort(revision, queue);
}

export async function createWebPageSource(input: {
  shopId: string;
  name: unknown;
  purposeKey: unknown;
  dataFormatKey: unknown;
  url: unknown;
  languageTag?: unknown;
  database?: Database;
  queue?: Parameters<typeof enqueueMerchantKnowledgeRevisionBestEffort>[1];
}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 160) throw invalid();
  const requestedUrl = parsePublicHttpsUrl(input.url);
  const type = parseSourceType(input.purposeKey, input.dataFormatKey);
  const database = input.database ?? db;
  const result = await database.$transaction(async (transaction) => {
    await lockShop(input.shopId, transaction);
    const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
    if (entitlement.kind !== "entitled") throw denied();
    const pair = await requireAllowedPair(transaction, entitlement.configuration, type);
    const activation = await readActivation(input.shopId, transaction);
    const shopSettings = await transaction.shopSettings.findUnique({
      where: { shopId: input.shopId },
      select: { defaultLanguageTag: true },
    });
    const languageTag = parseLanguageTag(input.languageTag, shopSettings?.defaultLanguageTag ?? null);
    const existing = await transaction.merchantKnowledgeSource.findMany({
      where: { shopId: input.shopId },
      select: { id: true, position: true, purpose: { select: { key: true, active: true } }, dataFormat: { select: { key: true, active: true } } },
    });
    const allowed = new Set(entitlement.configuration.allowedSourceTypes.map(({ purposeKey, dataFormatKey }) => `${purposeKey}\u0000${dataFormatKey}`));
    const entitledCount = existing.filter((source) => source.purpose.active && source.dataFormat.active && allowed.has(`${source.purpose.key}\u0000${source.dataFormat.key}`)).length;
    if (entitledCount >= entitlement.configuration.maxKnowledgeSources) throw denied();
    const position = existing.reduce((highest, source) => Math.max(highest, source.position), -1) + 1;
    const sourceId = randomUUID();
    await transaction.merchantKnowledgeSource.create({
      data: {
        id: sourceId,
        shopId: input.shopId,
        purposeId: pair.purposeId,
        dataFormatId: pair.dataFormatId,
        name,
        languageTag,
        position,
        currentGeneration: 1,
      },
    });
    const revision = await createRevision(transaction, {
      sourceId,
      shopId: input.shopId,
      generation: 1,
      reason: "CREATE",
      requestedUrl,
    });
    return { sourceId, revision, merchantEnabled: activation.merchantEnabled };
  });
  await enqueueIfEnabled(result.revision, result.merchantEnabled, input.queue);
  return { sourceId: result.sourceId };
}

export async function editWebPageSource(input: {
  shopId: string;
  sourceId: string;
  name: unknown;
  url: unknown;
  languageTag: unknown;
  database?: Database;
  queue?: Parameters<typeof enqueueMerchantKnowledgeRevisionBestEffort>[1];
}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 160) throw invalid();
  const requestedUrl = parsePublicHttpsUrl(input.url);
  const languageTag = parseLanguageTag(input.languageTag, null);
  const database = input.database ?? db;
  const result = await database.$transaction(async (transaction) => {
    await lockShop(input.shopId, transaction);
    const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
    if (entitlement.kind !== "entitled") throw denied();
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "commerce"."MerchantKnowledgeSource"
      WHERE "id" = ${input.sourceId} AND "shopId" = ${input.shopId}
      FOR UPDATE
    `);
    if (!rows.length) throw denied();
    const source = await transaction.merchantKnowledgeSource.findUniqueOrThrow({
      where: { id: input.sourceId },
      include: { revisions: { orderBy: [{ generation: "desc" }, { id: "desc" }], take: 1 } },
    });
    const pair = await loadSourcePair(source, transaction);
    if (!pair || pair.dataFormat.key !== "WEB_PAGE") throw denied();
    await requireAllowedPair(transaction, entitlement.configuration, { purposeKey: pair.purpose.key, dataFormatKey: pair.dataFormat.key });
    await requireCurrentlyPlanEntitledSource(transaction, input.shopId, source.id, entitlement.configuration);
    const latest = source.revisions[0];
    if (!latest) throw conflict();
    const urlChanged = latest.requestedUrl !== requestedUrl;
    const activation = await readActivation(input.shopId, transaction);
    await transaction.merchantKnowledgeSource.update({
      where: { id: source.id },
      data: { name, languageTag, ...(urlChanged ? { currentGeneration: { increment: 1 } } : {}) },
    });
    const revision = urlChanged ? await createRevision(transaction, {
      sourceId: source.id,
      shopId: input.shopId,
      generation: source.currentGeneration + 1,
      reason: "URL_CHANGE",
      requestedUrl,
    }) : null;
    return { revision, merchantEnabled: activation.merchantEnabled };
  });
  await enqueueIfEnabled(result.revision, result.merchantEnabled, input.queue);
  return { ok: true };
}

export async function refreshWebPageSource(input: {
  shopId: string;
  sourceId: string;
  database?: Database;
  queue?: Parameters<typeof enqueueMerchantKnowledgeRevisionBestEffort>[1];
}) {
  const database = input.database ?? db;
  const result = await database.$transaction(async (transaction) => {
    await lockShop(input.shopId, transaction);
    const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
    if (entitlement.kind !== "entitled") throw denied();
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "commerce"."MerchantKnowledgeSource"
      WHERE "id" = ${input.sourceId} AND "shopId" = ${input.shopId}
      FOR UPDATE
    `);
    if (!rows.length) throw denied();
    const source = await transaction.merchantKnowledgeSource.findUniqueOrThrow({
      where: { id: input.sourceId },
      include: { purpose: true, dataFormat: true, revisions: { orderBy: [{ generation: "desc" }, { id: "desc" }], take: 1 } },
    });
    if (source.dataFormat.key !== "WEB_PAGE" || !source.revisions[0]?.requestedUrl) throw denied();
    await requireAllowedPair(transaction, entitlement.configuration, { purposeKey: source.purpose.key, dataFormatKey: source.dataFormat.key });
    await requireCurrentlyPlanEntitledSource(transaction, input.shopId, source.id, entitlement.configuration);
    const activation = await readActivation(input.shopId, transaction);
    const generation = source.currentGeneration + 1;
    await transaction.merchantKnowledgeSource.update({ where: { id: source.id }, data: { currentGeneration: generation } });
    const revision = await createRevision(transaction, {
      sourceId: source.id,
      shopId: input.shopId,
      generation,
      reason: "REFRESH",
      requestedUrl: source.revisions[0].requestedUrl,
    });
    return { revision, merchantEnabled: activation.merchantEnabled };
  });
  await enqueueIfEnabled(result.revision, result.merchantEnabled, input.queue);
  return { ok: true };
}

async function rewritePositions(
  transaction: Transaction,
  shopId: string,
  sourceIds: readonly string[],
) {
  await transaction.merchantKnowledgeSource.updateMany({
    where: { shopId },
    data: { position: { increment: 1_000_000_000 } },
  });
  for (const [position, id] of sourceIds.entries()) {
    const updated = await transaction.merchantKnowledgeSource.updateMany({
      where: { id, shopId },
      data: { position },
    });
    if (updated.count !== 1) throw conflict();
  }
}

export async function deleteMerchantKnowledgeSource(input: {
  shopId: string;
  sourceId: string;
  database?: Database;
}) {
  const database = input.database ?? db;
  await database.$transaction(async (transaction) => {
    await lockShop(input.shopId, transaction);
    const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
    if (entitlement.kind !== "entitled") throw denied();
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "commerce"."MerchantKnowledgeSource"
      WHERE "id" = ${input.sourceId} AND "shopId" = ${input.shopId}
      FOR UPDATE
    `);
    if (!rows.length) throw denied();
    await transaction.merchantKnowledgeSource.delete({ where: { id: input.sourceId } });
    const remaining = await transaction.merchantKnowledgeSource.findMany({
      where: { shopId: input.shopId },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    await rewritePositions(transaction, input.shopId, remaining.map(({ id }) => id));
  });
  return { ok: true };
}

export async function reorderMerchantKnowledgeSources(input: {
  shopId: string;
  sourceIds: unknown;
  database?: Database;
}) {
  if (!Array.isArray(input.sourceIds) || input.sourceIds.some((id) => typeof id !== "string") || new Set(input.sourceIds).size !== input.sourceIds.length) throw invalid();
  const sourceIds = input.sourceIds as string[];
  const database = input.database ?? db;
  await database.$transaction(async (transaction) => {
    await lockShop(input.shopId, transaction);
    const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
    if (entitlement.kind !== "entitled") throw denied();
    const rows = await transaction.merchantKnowledgeSource.findMany({
      where: { shopId: input.shopId },
      select: { id: true },
    });
    if (rows.length !== sourceIds.length || rows.some(({ id }) => !sourceIds.includes(id))) throw conflict();
    await rewritePositions(transaction, input.shopId, sourceIds);
  });
  return { ok: true };
}

export { MODA_SUPPORTED_LANGUAGE_TAGS };