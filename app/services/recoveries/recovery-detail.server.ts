import { CheckoutRecoveryStatus, Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { detailCursor, detailCursorScope, InvalidRecoveryDetailQuery, parseDetailNavigation, validDetailId, type DetailBoundary } from "./detail-cursor.server";
import { recoveryMessageDto, type RecoveryMessageRow } from "./detail-message";

export type RecoveryDetailDatabase = { $queryRaw<T>(query: Prisma.Sql): Promise<T> };
type Identity = { shopId: string; recoveryId: string };
type PageInput = Identity & { cursor?: unknown; window?: unknown };
type OwnedRecovery = {
  id: string; customerId: string | null; conversationId: string | null;
  firstName: string | null; lastName: string | null; email: string | null;
  status: string; totalPrice: Prisma.Decimal | null; currency: string | null;
  detectedAt: Date; messageSentAt: Date | null; engagedAt: Date | null;
  completedAt: Date | null; expiredAt: Date | null;
};
type RelatedRow = Pick<OwnedRecovery, "id" | "status" | "totalPrice" | "currency" | "detectedAt">;

const emptyPage = <T>() => ({ items: [] as T[], previousCursor: null as string | null, nextCursor: null as string | null });
function statusDto(value: string) {
  return Object.values(CheckoutRecoveryStatus).includes(value as CheckoutRecoveryStatus) ? value as CheckoutRecoveryStatus : null;
}
function valueDto(row: RelatedRow) {
  return { amount: row.totalPrice?.toString() ?? null, currency: row.currency, incomplete: row.totalPrice === null || row.currency === null };
}
function boundary(id: string, date: Date): DetailBoundary { return { id, at: date.toISOString() }; }

async function ownedRecovery(db: RecoveryDetailDatabase, { shopId, recoveryId }: Identity): Promise<OwnedRecovery | null> {
  if (!validDetailId(shopId) || !validDetailId(recoveryId)) return null;
  const rows = await db.$queryRaw<OwnedRecovery[]>(Prisma.sql`
    SELECT r."id", c."id" AS "customerId", v."id" AS "conversationId",
      c."firstName", c."lastName", c."email", r."status", r."totalPrice", r."currency",
      r."detectedAt", r."messageSentAt", r."engagedAt", r."completedAt", r."expiredAt"
    FROM "commerce"."CheckoutRecovery" r
    LEFT JOIN "commerce"."Customer" c ON c."id" = r."customerId" AND c."shopId" = r."shopId"
    LEFT JOIN "whatsapp"."Conversation" v ON v."checkoutRecoveryId" = r."id"
    WHERE r."shopId" = ${shopId} AND r."id" = ${recoveryId} LIMIT 1`);
  return rows[0] ?? null;
}

/** Internal server readers: callers MUST authenticate/resolve shopId and enforce RECOVERY_HISTORY.
 * Never pass a browser-provided shopId. All three entry points independently resolve ownership.
 */
export async function readRecoveryDetail(input: Identity, db: RecoveryDetailDatabase = prisma) {
  const row = await ownedRecovery(db, input);
  if (!row) return null;
  return {
    id: row.id, status: statusDto(row.status), value: valueDto(row),
    customer: row.customerId ? { firstName: row.firstName, lastName: row.lastName, email: row.email } : null,
    hasConversation: row.conversationId !== null,
    milestones: { detectedAt: row.detectedAt.toISOString(), messageSentAt: row.messageSentAt?.toISOString() ?? null,
      engagedAt: row.engagedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
      expiredAt: row.expiredAt?.toISOString() ?? null },
  };
}

// Exported for actual-query EXPLAIN validation. These builders are not authorized readers.
export function recoveryMessagePageSql(conversationId: string, navigation: ReturnType<typeof parseDetailNavigation>) {
  const descending = navigation.direction === "latest" || navigation.direction === "previous";
  const key = navigation.boundary;
  const comparison = descending ? Prisma.sql`<` : Prisma.sql`>`;
  return Prisma.sql`SELECT "id", "createdAt", "direction", "senderType", "status", "contentType", "content",
    "transcriptionStatus", "sentAt", "deliveredAt", "readAt"
    FROM "whatsapp"."ConversationMessage"
    WHERE "conversationId" = ${conversationId}
    ${key ? Prisma.sql`AND ("createdAt", "id") ${comparison} (${new Date(key.at)}::timestamp, ${key.id})` : Prisma.empty}
    ORDER BY "createdAt" ${descending ? Prisma.sql`DESC` : Prisma.sql`ASC`}, "id" ${descending ? Prisma.sql`DESC` : Prisma.sql`ASC`}
    LIMIT 51`;
}

export async function readRecoveryMessages(input: PageInput, db: RecoveryDetailDatabase = prisma) {
  const scope = detailCursorScope(["messages", input.shopId, input.recoveryId]);
  // Validate syntax independently of resource existence, so missing/foreign IDs behave identically.
  const nav = parseDetailNavigation(scope, input);
  const owned = await ownedRecovery(db, input);
  if (!owned) return null;
  if (!owned.conversationId) return emptyPage<ReturnType<typeof recoveryMessageDto>>();
  const fetched = await db.$queryRaw<RecoveryMessageRow[]>(recoveryMessagePageSql(owned.conversationId, nav));
  const rows = fetched.slice(0, 50);
  if (nav.direction === "latest" || nav.direction === "previous") rows.reverse();
  if (!rows.length) return emptyPage<ReturnType<typeof recoveryMessageDto>>();
  const first = boundary(rows[0].id, rows[0].createdAt), last = boundary(rows[rows.length - 1].id, rows[rows.length - 1].createdAt);
  const [edges] = await db.$queryRaw<{ before: boolean; after: boolean }[]>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM "whatsapp"."ConversationMessage" WHERE "conversationId" = ${owned.conversationId}
      AND ("createdAt", "id") < (${new Date(first.at)}::timestamp, ${first.id})) AS "before",
    EXISTS (SELECT 1 FROM "whatsapp"."ConversationMessage" WHERE "conversationId" = ${owned.conversationId}
      AND ("createdAt", "id") > (${new Date(last.at)}::timestamp, ${last.id})) AS "after"`);
  return { items: rows.map(recoveryMessageDto), previousCursor: edges.before ? detailCursor(scope, "previous", first) : null,
    nextCursor: edges.after ? detailCursor(scope, "next", last) : null };
}

export async function readRelatedRecoveries(input: PageInput, db: RecoveryDetailDatabase = prisma) {
  if (input.window !== undefined) throw new InvalidRecoveryDetailQuery();
  const scope = detailCursorScope(["related", input.shopId, input.recoveryId]);
  const nav = parseDetailNavigation(scope, input);
  const owned = await ownedRecovery(db, input);
  if (!owned) return null;
  if (!owned.customerId) return emptyPage<{ id: string; status: CheckoutRecoveryStatus | null; value: ReturnType<typeof valueDto>; detectedAt: string }>();
  const ascending = nav.direction === "previous", key = nav.boundary;
  const predicate = Prisma.sql`"shopId" = ${input.shopId} AND "customerId" = ${owned.customerId} AND "id" <> ${owned.id}`;
  const fetched = await db.$queryRaw<RelatedRow[]>(Prisma.sql`
    SELECT "id", "status", "totalPrice", "currency", "detectedAt" FROM "commerce"."CheckoutRecovery"
    WHERE ${predicate}
    ${key ? Prisma.sql`AND ("detectedAt", "id") ${ascending ? Prisma.sql`>` : Prisma.sql`<`} (${new Date(key.at)}::timestamp, ${key.id})` : Prisma.empty}
    ORDER BY "detectedAt" ${ascending ? Prisma.sql`ASC` : Prisma.sql`DESC`}, "id" ${ascending ? Prisma.sql`ASC` : Prisma.sql`DESC`} LIMIT 6`);
  const rows = fetched.slice(0, 5);
  if (ascending) rows.reverse();
  if (!rows.length) return emptyPage<{ id: string; status: CheckoutRecoveryStatus | null; value: ReturnType<typeof valueDto>; detectedAt: string }>();
  const first = boundary(rows[0].id, rows[0].detectedAt), last = boundary(rows[rows.length - 1].id, rows[rows.length - 1].detectedAt);
  const [edges] = await db.$queryRaw<{ before: boolean; after: boolean }[]>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM "commerce"."CheckoutRecovery" WHERE ${predicate}
      AND ("detectedAt", "id") > (${new Date(first.at)}::timestamp, ${first.id})) AS "before",
    EXISTS (SELECT 1 FROM "commerce"."CheckoutRecovery" WHERE ${predicate}
      AND ("detectedAt", "id") < (${new Date(last.at)}::timestamp, ${last.id})) AS "after"`);
  return { items: rows.map(row => ({ id: row.id, status: statusDto(row.status), value: valueDto(row), detectedAt: row.detectedAt.toISOString() })),
    previousCursor: edges.before ? detailCursor(scope, "previous", first) : null, nextCursor: edges.after ? detailCursor(scope, "next", last) : null };
}
