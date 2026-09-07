import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import {
  AuthoredSupportBodySchema,
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,
  PLATFORM_SUPPORT_LANGUAGE_TAG,
  requiresMerchantTranslation,
} from "@modainteract/moda-interact-shared/merchant-communications";
import { canonicaliseLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import { createTranslationDispatchJobId } from "@modainteract/moda-interact-shared/merchant-communications/node";
import { Queue } from "bullmq";

import prisma from "../../db.server";

const MAX_PAGE_SIZE = 50;

type SupportQueue = Pick<Queue, "add">;

type TransactionClient = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type DatabaseClient = {
  $transaction<T>(callback: (transaction: TransactionClient) => Promise<T>): Promise<T>;
};

type MessageRow = {
  id: string;
  kind: "ADMINISTRATIVE" | "SYSTEM" | "MERCHANT";
  state: "PROCESSING" | "AVAILABLE" | "FAILED";
  originalBody: string;
  sourceLanguageTag: string;
  displayLanguageTag: string | null;
  translatedBody: string | null;
  translationStatus: "AVAILABLE" | null;
  createdAt: Date;
  readAt: Date | null;
};

const MERCHANT_VISIBLE_MESSAGE_PREDICATE = Prisma.sql`
  (
    m."kind" = 'MERCHANT'
    OR (m."kind" IN ('ADMINISTRATIVE', 'SYSTEM') AND m."state" = 'AVAILABLE')
  )
`;

let queue: Queue | null = null;
let queueUrl: string | null = null;

function clampPage(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function clampPageSize(value: number): number {
  return Math.min(Math.max(Number.isInteger(value) ? value : 25, 1), MAX_PAGE_SIZE);
}

export function trustedSupportLanguageTag(value: string | null | undefined): string {
  if (!value) return PLATFORM_SUPPORT_LANGUAGE_TAG;
  try {
    return canonicaliseLanguageTag(value);
  } catch {
    return PLATFORM_SUPPORT_LANGUAGE_TAG;
  }
}

async function getQueue(): Promise<SupportQueue | null> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) return null;
  if (queue && queueUrl === redisUrl) return queue;
  if (queue) await queue.close();
  queueUrl = redisUrl;
  queue = new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
    connection: {
      url: redisUrl,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_500,
      commandTimeout: 2_500,
    },
  });
  return queue;
}

export async function enqueueTranslationBestEffort(
  translationId: string,
  injectedQueue?: SupportQueue | null,
): Promise<void> {
  const targetQueue = injectedQueue === undefined ? await getQueue() : injectedQueue;
  if (!targetQueue) return;
  try {
    await targetQueue.add(
      MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_DISPATCH,
      { schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION, translationId },
      { jobId: createTranslationDispatchJobId(translationId) },
    );
  } catch {
    // Durable translation state is committed before this best-effort hint.
  }
}

export type ComposeMerchantMessageInput = {
  shopId: string;
  body: string;
  shopifyUserId?: string | number | bigint | null;
  database?: DatabaseClient;
  queue?: SupportQueue | null;
};

export async function composeMerchantMessage(input: ComposeMerchantMessageInput) {
  const body = AuthoredSupportBodySchema.parse(input.body);
  const database = input.database ?? (prisma as unknown as DatabaseClient);
  const messageId = randomUUID();
  const result = await database.$transaction(async (transaction) => {
    const settings = await transaction.$queryRaw<[{ defaultLanguageTag: string | null }]>(Prisma.sql`
      SELECT "defaultLanguageTag"
      FROM "shopify"."ShopSettings"
      WHERE "shopId" = ${input.shopId}
    `);
    const displayLanguageTag = trustedSupportLanguageTag(settings[0]?.defaultLanguageTag);
    const needsTranslation = requiresMerchantTranslation(
      displayLanguageTag,
      PLATFORM_SUPPORT_LANGUAGE_TAG,
    );
    const now = new Date();
    const threadId = randomUUID();
    const thread = await transaction.$queryRaw<[{ id: string }]>(Prisma.sql`
      INSERT INTO "support"."MerchantSupportThread" (
        "id", "shopId", "createdAt", "updatedAt"
      ) VALUES (${threadId}, ${input.shopId}, ${now}, ${now})
      ON CONFLICT ("shopId") DO UPDATE SET "updatedAt" = ${now}
      RETURNING "id"
    `);
    const persistedThreadId = thread[0]?.id;
    if (!persistedThreadId) throw new Error("Unable to create merchant support thread.");

    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "support"."MerchantSupportMessage" (
        "id", "threadId", "kind", "state", "originalBody", "sourceLanguageTag",
        "displayLanguageTag", "shopifyUserId", "availableAt", "createdAt", "updatedAt"
      ) VALUES (
        ${messageId}, ${persistedThreadId}, 'MERCHANT', 'AVAILABLE', ${body},
        ${displayLanguageTag}, ${displayLanguageTag},
        ${input.shopifyUserId == null ? null : String(input.shopifyUserId)},
        ${now}, ${now}, ${now}
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      UPDATE "support"."MerchantSupportThread"
      SET "lastMessageAt" = ${now}, "lastMerchantMessageAt" = ${now},
        "merchantMessageVersion" = "merchantMessageVersion" + 1,
        "needsAdminResponse" = true, "updatedAt" = ${now}
      WHERE "id" = ${persistedThreadId} AND "shopId" = ${input.shopId}
    `);

    if (!needsTranslation) return { translationId: null };
    const translationId = randomUUID();
    await transaction.$executeRaw(Prisma.sql`
      INSERT INTO "support"."MerchantMessageTranslation" (
        "id", "messageId", "direction", "sourceLanguageTag", "targetLanguageTag",
        "status", "createdAt", "updatedAt"
      ) VALUES (
        ${translationId}, ${messageId}, 'MERCHANT_TO_ADMIN',
        ${displayLanguageTag}, ${PLATFORM_SUPPORT_LANGUAGE_TAG}, 'PENDING', ${now}, ${now}
      )
    `);
    return { translationId };
  });

  if (result.translationId) {
    await enqueueTranslationBestEffort(result.translationId, input.queue);
  }
  return { messageId, translationId: result.translationId };
}

export type MerchantSupportPage = {
  page: number;
  pageSize: number;
  total: number;
  unread: number;
  totalPages: number;
  items: Array<{
    id: string;
    kind: MessageRow["kind"];
    state: MessageRow["state"];
    originalBody: string;
    displayBody: string | null;
    isTranslated: boolean;
    sourceLanguageTag: string;
    displayLanguageTag: string | null;
    createdAt: string;
    readAt: string | null;
  }>;
};

export async function readMerchantSupportMessages(input: {
  shopId: string;
  page?: number;
  pageSize?: number;
  database?: DatabaseClient;
}): Promise<MerchantSupportPage> {
  const page = clampPage(input.page ?? 1);
  const pageSize = clampPageSize(input.pageSize ?? 25);
  const database = input.database ?? (prisma as unknown as DatabaseClient);
  const offset = (page - 1) * pageSize;
  const rows = await database.$transaction(async (transaction) => {
    const messages = await transaction.$queryRaw<MessageRow[]>(Prisma.sql`
      SELECT m."id", m."kind", m."state", m."originalBody", m."sourceLanguageTag",
        m."displayLanguageTag", m."createdAt", m."readAt",
        tr."translatedBody", tr."status" AS "translationStatus"
      FROM "support"."MerchantSupportMessage" m
      INNER JOIN "support"."MerchantSupportThread" t ON t."id" = m."threadId"
      LEFT JOIN LATERAL (
        SELECT "translatedBody", "status"
        FROM "support"."MerchantMessageTranslation"
        WHERE "messageId" = m."id"
          AND "targetLanguageTag" = m."displayLanguageTag"
          AND "status" = 'AVAILABLE'
        ORDER BY "createdAt" DESC
        LIMIT 1
      ) tr ON true
      WHERE t."shopId" = ${input.shopId}
        AND ${MERCHANT_VISIBLE_MESSAGE_PREDICATE}
      ORDER BY m."createdAt" ASC, m."id" ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `);
    const [{ count }] = await transaction.$queryRaw<[{ count: bigint }]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count"
      FROM "support"."MerchantSupportMessage" m
      INNER JOIN "support"."MerchantSupportThread" t ON t."id" = m."threadId"
      WHERE t."shopId" = ${input.shopId}
        AND ${MERCHANT_VISIBLE_MESSAGE_PREDICATE}
    `);
    const [{ unread }] = await transaction.$queryRaw<[{ unread: bigint }]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "unread"
      FROM "support"."MerchantSupportMessage" m
      INNER JOIN "support"."MerchantSupportThread" t ON t."id" = m."threadId"
      WHERE t."shopId" = ${input.shopId}
        AND m."kind" IN ('ADMINISTRATIVE', 'SYSTEM')
        AND m."state" = 'AVAILABLE' AND m."readAt" IS NULL
    `);
    return { messages, total: Number(count), unread: Number(unread) };
  });

  return {
    page,
    pageSize,
    total: rows.total,
    unread: rows.unread,
    totalPages: Math.max(1, Math.ceil(rows.total / pageSize)),
    items: rows.messages.map((message) => {
      const translationRequired = message.displayLanguageTag
        ? requiresMerchantTranslation(message.sourceLanguageTag, message.displayLanguageTag)
        : false;
      return {
        id: message.id,
        kind: message.kind,
        state: message.state,
        originalBody: !translationRequired || message.translationStatus === "AVAILABLE"
          ? message.originalBody
          : "",
        displayBody: translationRequired
          ? message.translationStatus === "AVAILABLE" ? message.translatedBody : null
          : message.originalBody,
        isTranslated: translationRequired && message.translationStatus === "AVAILABLE" && message.translatedBody !== null,
        sourceLanguageTag: message.sourceLanguageTag,
        displayLanguageTag: message.displayLanguageTag,
        createdAt: message.createdAt.toISOString(),
        readAt: message.readAt?.toISOString() ?? null,
      };
    }),
  };
}

export async function markMerchantSupportMessageRead(input: {
  shopId: string;
  messageId: string;
  database?: DatabaseClient;
}): Promise<boolean> {
  const database = input.database ?? (prisma as unknown as DatabaseClient);
  return database.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<[{ id: string }]>(Prisma.sql`
      SELECT m."id"
      FROM "support"."MerchantSupportMessage" m
      INNER JOIN "support"."MerchantSupportThread" t ON t."id" = m."threadId"
      WHERE m."id" = ${input.messageId}
        AND t."shopId" = ${input.shopId}
        AND m."kind" IN ('ADMINISTRATIVE', 'SYSTEM')
        AND m."state" = 'AVAILABLE'
    `);
    if (!rows[0]) return false;
    await transaction.$executeRaw(Prisma.sql`
      UPDATE "support"."MerchantSupportMessage"
      SET "readAt" = COALESCE("readAt", NOW()), "updatedAt" = NOW()
      WHERE "id" = ${input.messageId}
        AND "kind" IN ('ADMINISTRATIVE', 'SYSTEM')
        AND "state" = 'AVAILABLE'
    `);
    return true;
  });
}

export async function resetMerchantSupportQueueForTests(): Promise<void> {
  if (queue) await queue.close();
  queue = null;
  queueUrl = null;
}