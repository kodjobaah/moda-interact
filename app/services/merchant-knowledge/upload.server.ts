import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MerchantKnowledgeDataFormatKeySchema,
  MerchantKnowledgePurposeKeySchema,
} from "@modainteract/moda-interact-shared/merchant-knowledge";
import {
  ModaSupportedLanguageTagSchema,
  resolveModaConfigurationLocale,
} from "@modainteract/moda-interact-shared/internationalization";
import db from "@/db.server";
import { loadCurrentMerchantKnowledgeEntitlement } from "./merchant-knowledge-entitlement.server";
import {
  createMerchantKnowledgeRevision,
  enqueueMerchantKnowledgeRevisionIfEnabled,
  lockMerchantKnowledgeShop,
  MerchantKnowledgeError,
  readMerchantKnowledgeActivation,
  requireAllowedPair,
  requireCurrentlyPlanEntitledSource,
  type MerchantKnowledgeTransaction,
} from "./merchant-knowledge.server";
import { createMerchantKnowledgeR2Client, type MerchantKnowledgeR2Client } from "./r2-client.server";
import { loadMerchantKnowledgeR2Config, type MerchantKnowledgeR2Config } from "./r2-config.server";

type Database = Pick<PrismaClient,
  "$transaction" | "merchantKnowledgeDataFormat" | "merchantKnowledgePurposeDataFormat"
  | "merchantKnowledgeUploadedAsset" | "merchantKnowledgeSource" | "merchantKnowledgeSourceRevision"
  | "shopSettings" | "subscription" | "feature" | "shopFeaturePreference"
>;
type Queue = Parameters<typeof enqueueMerchantKnowledgeRevisionIfEnabled>[2];
type DataFormatKey = "CSV" | "XLSX";

const INVALID = () => new MerchantKnowledgeError("INVALID_INPUT");
const DENIED = () => new MerchantKnowledgeError("DENIED");
const CONFLICT = () => new MerchantKnowledgeError("CONFLICT");
const SIGNED_PUT_SECONDS = 600;

function positiveSafeInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

function acceptedTypes(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return [];
  return value as string[];
}

function contentTypeKey(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function parseFileName(value: unknown, maxLength: number): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > maxLength) throw INVALID();
  return name;
}

function parseLanguage(value: unknown, defaultLanguageTag: string | null): string {
  const candidate = value === undefined || value === null || value === ""
    ? resolveModaConfigurationLocale(defaultLanguageTag)
    : value;
  const result = ModaSupportedLanguageTagSchema.safeParse(candidate);
  if (!result.success) throw INVALID();
  return result.data;
}

function parsePurpose(value: unknown): string {
  const parsed = MerchantKnowledgePurposeKeySchema.safeParse(value);
  if (!parsed.success) throw INVALID();
  return parsed.data;
}

function parseFormat(value: unknown): DataFormatKey {
  const parsed = MerchantKnowledgeDataFormatKeySchema.safeParse(value);
  if (!parsed.success || (parsed.data !== "CSV" && parsed.data !== "XLSX")) throw INVALID();
  return parsed.data;
}

function dataFormatKey(key: string): DataFormatKey {
  if (key !== "CSV" && key !== "XLSX") throw DENIED();
  return key;
}

function normalizeError(error: unknown): never {
  if (error instanceof MerchantKnowledgeError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") throw DENIED();
  throw error;
}

function dependencies(input: {
  database?: Database;
  r2?: MerchantKnowledgeR2Client;
  config?: MerchantKnowledgeR2Config;
  queue?: Queue;
}) {
  const config = input.config ?? loadMerchantKnowledgeR2Config();
  return {
    database: input.database ?? db,
    config,
    r2: input.r2 ?? createMerchantKnowledgeR2Client(config),
    queue: input.queue,
  };
}

export async function createMerchantKnowledgeUploadIntent(input: {
  shopId: string;
  purposeKey: unknown;
  dataFormatKey: unknown;
  originalFileName: unknown;
  contentType: unknown;
  sizeBytes: unknown;
  database?: Database;
  r2?: MerchantKnowledgeR2Client;
  config?: MerchantKnowledgeR2Config;
  now?: () => Date;
}) {
  const deps = dependencies(input);
  const purposeKey = parsePurpose(input.purposeKey);
  const formatKey = parseFormat(input.dataFormatKey);
  const originalFileName = parseFileName(input.originalFileName, 255);
  if (typeof input.contentType !== "string" || !input.contentType.trim()) throw INVALID();
  const contentType = input.contentType.trim();
  if (!positiveSafeInteger(input.sizeBytes, deps.config.maxUploadBytes)) throw INVALID();

  try {
    const intent = await deps.database.$transaction(async (transaction) => {
      await lockMerchantKnowledgeShop(input.shopId, transaction);
      const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
      if (entitlement.kind !== "entitled") throw DENIED();
      await readMerchantKnowledgeActivation(input.shopId, transaction);
      const pair = await requireAllowedPair(transaction, entitlement.configuration, { purposeKey, dataFormatKey: formatKey }, "UPLOAD");
      const format = await transaction.merchantKnowledgeDataFormat.findUniqueOrThrow({
        where: { id: pair.dataFormatId },
        select: { id: true, key: true, inputKind: true, canonicalExtension: true, acceptedContentTypes: true, active: true },
      });
      const extension = format.canonicalExtension?.toLowerCase();
      const suffix = `.${formatKey.toLowerCase()}`;
      const allowedTypes = acceptedTypes(format.acceptedContentTypes);
      if (!format.active || format.inputKind !== "UPLOAD" || extension !== suffix) throw DENIED();
      if (!originalFileName.toLowerCase().endsWith(suffix)) throw INVALID();
      if (!allowedTypes.some((candidate) => contentTypeKey(candidate) === contentTypeKey(contentType))) throw INVALID();

      const id = randomUUID();
      const now = input.now?.() ?? new Date();
      const uploadExpiresAt = new Date(now.getTime() + SIGNED_PUT_SECONDS * 1000);
      const objectKey = `merchant-knowledge/${input.shopId}/${id}/source.${formatKey.toLowerCase()}`;
      await transaction.merchantKnowledgeUploadedAsset.create({
        data: {
          id,
          shopId: input.shopId,
          dataFormatId: format.id,
          status: "PENDING_UPLOAD",
          objectKey,
          originalFileName,
          uploadExpiresAt,
        },
      });
      return { id, objectKey, uploadExpiresAt };
    });
    const uploadUrl = await deps.r2.signPut({
      bucket: deps.config.bucket,
      key: intent.objectKey,
      contentType,
      expiresIn: SIGNED_PUT_SECONDS,
    });
    return {
      assetId: intent.id,
      uploadUrl,
      expiresAt: intent.uploadExpiresAt.toISOString(),
      requiredHeaders: { "Content-Type": contentType },
      maxUploadBytes: deps.config.maxUploadBytes,
    };
  } catch (error) {
    normalizeError(error);
  }
}

async function markAssetAvailable(
  transaction: MerchantKnowledgeTransaction,
  input: { assetId: string; shopId: string; contentType: string; sizeBytes: number; sha256: string; now: Date },
) {
  return transaction.merchantKnowledgeUploadedAsset.update({
    where: { id: input.assetId },
    data: {
      status: "AVAILABLE",
      contentType: input.contentType,
      sizeBytes: BigInt(input.sizeBytes),
      sha256: input.sha256,
      availableAt: input.now,
    },
    select: { id: true },
  });
}

export async function finalizeMerchantKnowledgeUpload(input: {
  shopId: string;
  assetId: unknown;
  purposeKey: unknown;
  name: unknown;
  languageTag: unknown;
  sizeBytes: unknown;
  sha256: unknown;
  contentType: unknown;
  sourceId?: unknown;
  database?: Database;
  r2?: MerchantKnowledgeR2Client;
  config?: MerchantKnowledgeR2Config;
  queue?: Queue;
  now?: () => Date;
}) {
  const deps = dependencies(input);
  const assetId = typeof input.assetId === "string" && input.assetId.length <= 128 ? input.assetId : "";
  const purposeKey = parsePurpose(input.purposeKey);
  const name = parseFileName(input.name, 160);
  const parsedLanguage = ModaSupportedLanguageTagSchema.safeParse(input.languageTag);
  if (!parsedLanguage.success) throw INVALID();
  const languageTag = parsedLanguage.data;
  const sourceId = input.sourceId === undefined || input.sourceId === null || input.sourceId === ""
    ? undefined
    : typeof input.sourceId === "string" && input.sourceId.length <= 128 ? input.sourceId : "INVALID";
  if (!assetId || sourceId === "INVALID") throw INVALID();
  if (!positiveSafeInteger(input.sizeBytes, deps.config.maxUploadBytes)) throw INVALID();
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) throw INVALID();
  if (typeof input.contentType !== "string" || !input.contentType.trim()) throw INVALID();
  const contentType = input.contentType.trim();
  const initialNow = input.now?.() ?? new Date();

  try {
    const asset = await deps.database.merchantKnowledgeUploadedAsset.findUnique({
      where: { id: assetId },
      select: {
        id: true, shopId: true, dataFormatId: true, status: true, objectKey: true,
        uploadExpiresAt: true, dataFormat: { select: { key: true, inputKind: true, active: true, acceptedContentTypes: true } },
      },
    });
    if (!asset || asset.shopId !== input.shopId) throw DENIED();
    if (asset.status !== "PENDING_UPLOAD" || asset.uploadExpiresAt < initialNow) throw CONFLICT();
    const formatKey = dataFormatKey(asset.dataFormat.key);
    const allowedTypes = acceptedTypes(asset.dataFormat.acceptedContentTypes);
    if (asset.dataFormat.inputKind !== "UPLOAD" || !asset.dataFormat.active) throw DENIED();
    if (!allowedTypes.some((candidate) => contentTypeKey(candidate) === contentTypeKey(contentType))) throw INVALID();

    let metadata;
    try {
      metadata = await deps.r2.headObject({ bucket: deps.config.bucket, key: asset.objectKey });
    } catch {
      throw new MerchantKnowledgeError("UPLOAD_OBJECT_NOT_FOUND");
    }
    if (metadata.contentLength !== input.sizeBytes || metadata.contentLength > deps.config.maxUploadBytes) {
      throw new MerchantKnowledgeError("UPLOAD_SIZE_MISMATCH");
    }
    if (!metadata.contentType || contentTypeKey(metadata.contentType) !== contentTypeKey(contentType)) {
      throw new MerchantKnowledgeError("UPLOAD_CONTENT_TYPE_MISMATCH");
    }

    const finalizedAt = input.now?.() ?? new Date();
    const result = await deps.database.$transaction(async (transaction) => {
      await lockMerchantKnowledgeShop(input.shopId, transaction);
      const lockedAsset = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "commerce"."MerchantKnowledgeUploadedAsset"
        WHERE "id" = ${assetId} AND "shopId" = ${input.shopId} AND "status" = 'PENDING_UPLOAD'
          AND "uploadExpiresAt" >= ${finalizedAt}
        FOR UPDATE
      `);
      if (!lockedAsset.length) throw CONFLICT();

      const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
      if (entitlement.kind !== "entitled") throw DENIED();
      const pair = await requireAllowedPair(transaction, entitlement.configuration, {
        purposeKey,
        dataFormatKey: formatKey,
      }, "UPLOAD");
      if (pair.dataFormatId !== asset.dataFormatId) throw DENIED();
      const activation = await readMerchantKnowledgeActivation(input.shopId, transaction);
      let source: {
        id: string;
        purposeId: string;
        dataFormatId: string;
        currentGeneration: number;
        purpose: { key: string };
        dataFormat: { key: string };
      } | null = null;
      if (sourceId) {
        const lockedSource = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "commerce"."MerchantKnowledgeSource"
          WHERE "id" = ${sourceId} AND "shopId" = ${input.shopId}
          FOR UPDATE
        `);
        if (!lockedSource.length) throw DENIED();
        source = await transaction.merchantKnowledgeSource.findUniqueOrThrow({
          where: { id: sourceId },
          select: { id: true, purposeId: true, dataFormatId: true, currentGeneration: true, name: true, languageTag: true,
            purpose: { select: { key: true } }, dataFormat: { select: { key: true } } },
        });
        if (source.dataFormatId !== asset.dataFormatId || source.dataFormat.key !== formatKey || source.purpose.key !== purposeKey) throw DENIED();
        await requireAllowedPair(transaction, entitlement.configuration, { purposeKey, dataFormatKey: formatKey }, "UPLOAD");
        await requireCurrentlyPlanEntitledSource(transaction, input.shopId, source.id, entitlement.configuration);
      }

      let generation: number;
      let actualSourceId: string;
      let reason: "CREATE" | "FILE_REPLACE";
      if (source) {
        generation = source.currentGeneration + 1;
        actualSourceId = source.id;
        reason = "FILE_REPLACE";
        await transaction.merchantKnowledgeSource.update({
          where: { id: source.id },
          data: { name, languageTag, currentGeneration: generation },
        });
      } else {
        const sources = await transaction.merchantKnowledgeSource.findMany({
          where: { shopId: input.shopId },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: { id: true, position: true, purpose: { select: { key: true, active: true } }, dataFormat: { select: { key: true, active: true } } },
        });
        const allowed = new Set(entitlement.configuration.allowedSourceTypes.map((entry) => `${entry.purposeKey}\u0000${entry.dataFormatKey}`));
        const eligible = sources.filter((entry) => entry.purpose.active && entry.dataFormat.active && allowed.has(`${entry.purpose.key}\u0000${entry.dataFormat.key}`));
        if (eligible.length >= entitlement.configuration.maxKnowledgeSources) throw DENIED();
        const settings = await transaction.shopSettings.findUnique({ where: { shopId: input.shopId }, select: { defaultLanguageTag: true } });
        const selectedLanguageTag = parseLanguage(languageTag, settings?.defaultLanguageTag ?? null);
        actualSourceId = randomUUID();
        generation = 1;
        reason = "CREATE";
        await transaction.merchantKnowledgeSource.create({
          data: {
            id: actualSourceId,
            shopId: input.shopId,
            purposeId: pair.purposeId,
            dataFormatId: pair.dataFormatId,
            name,
            languageTag: selectedLanguageTag,
            position: sources.reduce((highest, entry) => Math.max(highest, entry.position), -1) + 1,
            currentGeneration: generation,
          },
        });
      }
      await markAssetAvailable(transaction, { assetId, shopId: input.shopId, contentType, sizeBytes: input.sizeBytes as number, sha256: input.sha256 as string, now: finalizedAt });
      const revision = await createMerchantKnowledgeRevision(transaction, {
        sourceId: actualSourceId,
        shopId: input.shopId,
        generation,
        reason,
        requestedUrl: null,
        uploadedAssetId: assetId,
      });
      return { sourceId: actualSourceId, revision, merchantEnabled: activation.merchantEnabled };
    });
    const queued = await enqueueMerchantKnowledgeRevisionIfEnabled(result.revision, result.merchantEnabled, deps.queue);
    return { sourceId: result.sourceId, queued };
  } catch (error) {
    normalizeError(error);
  }
}

export async function editMerchantKnowledgeUploadSource(input: {
  shopId: string;
  sourceId: string;
  name: unknown;
  languageTag: unknown;
  database?: Database;
}) {
  const name = parseFileName(input.name, 160);
  const database = input.database ?? db;
  try {
    await database.$transaction(async (transaction) => {
      await lockMerchantKnowledgeShop(input.shopId, transaction);
      const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
      if (entitlement.kind !== "entitled") throw DENIED();
      const locks = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "commerce"."MerchantKnowledgeSource"
        WHERE "id" = ${input.sourceId} AND "shopId" = ${input.shopId}
        FOR UPDATE
      `);
      if (!locks.length) throw DENIED();
      const source = await transaction.merchantKnowledgeSource.findUniqueOrThrow({
        where: { id: input.sourceId },
        include: { purpose: true, dataFormat: true },
      });
      const formatKey = dataFormatKey(source.dataFormat.key);
      if (source.dataFormat.inputKind !== "UPLOAD") throw DENIED();
      await requireAllowedPair(transaction, entitlement.configuration, {
        purposeKey: source.purpose.key,
        dataFormatKey: formatKey,
      }, "UPLOAD");
      await requireCurrentlyPlanEntitledSource(transaction, input.shopId, source.id, entitlement.configuration);
      const settings = await transaction.shopSettings.findUnique({
        where: { shopId: input.shopId },
        select: { defaultLanguageTag: true },
      });
      await transaction.merchantKnowledgeSource.update({
        where: { id: source.id },
        data: { name, languageTag: parseLanguage(input.languageTag, settings?.defaultLanguageTag ?? null) },
      });
    });
    return { ok: true };
  } catch (error) {
    normalizeError(error);
  }
}

export async function reprocessMerchantKnowledgeUpload(input: {
  shopId: string;
  sourceId: string;
  database?: Database;
  queue?: Queue;
}) {
  const database = input.database ?? db;
  try {
    const result = await database.$transaction(async (transaction) => {
      await lockMerchantKnowledgeShop(input.shopId, transaction);
      const entitlement = await loadCurrentMerchantKnowledgeEntitlement(input.shopId, transaction);
      if (entitlement.kind !== "entitled") throw DENIED();
      const locks = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "commerce"."MerchantKnowledgeSource"
        WHERE "id" = ${input.sourceId} AND "shopId" = ${input.shopId}
        FOR UPDATE
      `);
      if (!locks.length) throw DENIED();
      const source = await transaction.merchantKnowledgeSource.findUniqueOrThrow({
        where: { id: input.sourceId },
        include: { purpose: true, dataFormat: true },
      });
      const formatKey = dataFormatKey(source.dataFormat.key);
      const currentRevision = await transaction.merchantKnowledgeSourceRevision.findUnique({
        where: { sourceId_generation: { sourceId: source.id, generation: source.currentGeneration } },
        select: { uploadedAssetId: true },
      });
      if (source.dataFormat.inputKind !== "UPLOAD" || !currentRevision?.uploadedAssetId) throw DENIED();
      await requireAllowedPair(transaction, entitlement.configuration, { purposeKey: source.purpose.key, dataFormatKey: formatKey }, "UPLOAD");
      await requireCurrentlyPlanEntitledSource(transaction, input.shopId, source.id, entitlement.configuration);
      const assetId = currentRevision.uploadedAssetId;
      const asset = await transaction.merchantKnowledgeUploadedAsset.findUnique({
        where: { id: assetId },
        select: { id: true, shopId: true, status: true, dataFormatId: true },
      });
      if (!asset || asset.status !== "AVAILABLE" || asset.shopId !== input.shopId || asset.dataFormatId !== source.dataFormatId) throw DENIED();
      const activation = await readMerchantKnowledgeActivation(input.shopId, transaction);
      const generation = source.currentGeneration + 1;
      await transaction.merchantKnowledgeSource.update({ where: { id: source.id }, data: { currentGeneration: generation } });
      const revision = await createMerchantKnowledgeRevision(transaction, {
        sourceId: source.id, shopId: input.shopId, generation, reason: "REPROCESS", requestedUrl: null, uploadedAssetId: asset.id,
      });
      return { revision, merchantEnabled: activation.merchantEnabled };
    });
    await enqueueMerchantKnowledgeRevisionIfEnabled(result.revision, result.merchantEnabled, input.queue);
    return { ok: true };
  } catch (error) {
    normalizeError(error);
  }
}