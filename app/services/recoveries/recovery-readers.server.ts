import { CheckoutRecoveryStatus, Prisma } from "@prisma/client";
import prisma from "../../db.server";
import {
  assertRecoveryQuery,
  decodeRecoveryCursor,
  encodeRecoveryCursor,
  ongoingStatuses,
  type RecoveryQuery,
} from "./recovery-query.server";

type Reader = Pick<Prisma.TransactionClient, "$queryRaw">;
export type RecoveryListRow = {
  id: string;
  customer: { displayName: string | null; email: string | null } | null;
  status: CheckoutRecoveryStatus;
  totalPrice: string | null;
  currency: string | null;
  detectedAt: string;
  // The consuming UI localizes "Checkout · {dateTime}" using this safe label descriptor.
  displayLabel: { kind: "checkout"; detectedAt: string };
};
export type RecoveryPage = {
  items: RecoveryListRow[];
  previousCursor: string | null;
  nextCursor: string | null;
};
export type RecoverySummary = {
  started: number;
  recovered: number;
  ongoing: number;
  recoveryRate: number | null;
  statuses: Record<CheckoutRecoveryStatus, number>;
  recoveredValues: { currency: string; totalPrice: string; count: number }[];
  unknownValueCount: number;
};
const cohort = (shopId: string, query: RecoveryQuery) =>
  Prisma.sql`r."shopId" = ${shopId} AND r."detectedAt" >= ${new Date(query.start)} AND r."detectedAt" < ${new Date(query.end)}`;
function count(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Recovery count outside supported range");
  return result;
}

/** Summary deliberately ignores status, search and pagination. Aggregation stays in PostgreSQL. */
export async function readRecoveryCohortSummary(
  shopId: string,
  query: RecoveryQuery,
  db: Reader = prisma,
): Promise<RecoverySummary> {
  assertRecoveryQuery(query, shopId);
  decodeRecoveryCursor(query, shopId); // Fail closed before any read, even on overview requests.
  const groups = await db.$queryRaw<
    Array<{
      status: CheckoutRecoveryStatus;
      currency: string | null;
      count: bigint;
      knownCount: bigint;
      totalPrice: string | null;
    }>
  >(Prisma.sql`
    SELECT r."status", CASE WHEN r."status" = 'COMPLETED' AND r."totalPrice" IS NOT NULL
      THEN NULLIF(BTRIM(r."currency"), '') ELSE NULL END AS currency,
      COUNT(*) AS count,
      COUNT(*) FILTER (WHERE r."status" = 'COMPLETED' AND r."totalPrice" IS NOT NULL AND NULLIF(BTRIM(r."currency"), '') IS NOT NULL) AS "knownCount",
      (SUM(r."totalPrice") FILTER (WHERE r."status" = 'COMPLETED' AND r."totalPrice" IS NOT NULL AND NULLIF(BTRIM(r."currency"), '') IS NOT NULL))::text AS "totalPrice"
    FROM commerce."CheckoutRecovery" r WHERE ${cohort(shopId, query)}
    GROUP BY r."status", 2 ORDER BY r."status", currency`);
  const statuses = Object.fromEntries(
    Object.values(CheckoutRecoveryStatus).map((status) => [status, 0]),
  ) as Record<CheckoutRecoveryStatus, number>;
  const recoveredValues: RecoverySummary["recoveredValues"] = [];
  let unknownValueCount = 0;
  for (const group of groups) {
    statuses[group.status] += count(group.count);
    if (group.status === CheckoutRecoveryStatus.COMPLETED) {
      unknownValueCount += count(group.count - group.knownCount);
      if (
        group.currency !== null &&
        group.totalPrice !== null &&
        group.knownCount > 0n
      )
        recoveredValues.push({
          currency: group.currency,
          totalPrice: group.totalPrice,
          count: count(group.knownCount),
        });
    }
  }
  const started = Object.values(statuses).reduce((sum, n) => sum + n, 0);
  const recovered = statuses.COMPLETED;
  return {
    started,
    recovered,
    ongoing: ongoingStatuses.reduce((sum, status) => sum + statuses[status], 0),
    recoveryRate: started === 0 ? null : recovered / started,
    statuses,
    recoveredValues,
    unknownValueCount,
  };
}

/** Safe projection and tenant-constrained join also defend inconsistent legacy customer links. */
export async function readRecoveryPage(
  shopId: string,
  query: RecoveryQuery,
  db: Reader = prisma,
): Promise<RecoveryPage> {
  assertRecoveryQuery(query, shopId);
  const boundary = decodeRecoveryCursor(query, shopId);
  const backwards = boundary?.direction === "previous";
  const status =
    query.status === "all"
      ? Prisma.empty
      : query.status === "ongoing"
        ? Prisma.sql`AND r."status" IN (${Prisma.join(ongoingStatuses.map((value) => Prisma.sql`${value}::commerce."CheckoutRecoveryStatus"`))})`
        : Prisma.sql`AND r."status" = ${query.status}::commerce."CheckoutRecoveryStatus"`;
  // Explicit escape character avoids dependence on SQL string/backslash configuration.
  const pattern = `%${query.q.replace(/[!%_]/g, (character) => `!${character}`)}%`;
  const search = query.q
    ? Prisma.sql`AND (c."firstName" ILIKE ${pattern} ESCAPE '!' OR c."lastName" ILIKE ${pattern} ESCAPE '!'
    OR BTRIM(CONCAT_WS(' ', NULLIF(BTRIM(c."firstName"), ''), NULLIF(BTRIM(c."lastName"), ''))) ILIKE ${pattern} ESCAPE '!' OR c."email" ILIKE ${pattern} ESCAPE '!')`
    : Prisma.empty;
  const seek = !boundary
    ? Prisma.empty
    : backwards
      ? Prisma.sql`AND (r."detectedAt", r."id") > (${new Date(boundary.detectedAt)}, ${boundary.id})`
      : Prisma.sql`AND (r."detectedAt", r."id") < (${new Date(boundary.detectedAt)}, ${boundary.id})`;
  const order = backwards ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      status: CheckoutRecoveryStatus;
      totalPrice: string | null;
      currency: string | null;
      detectedAt: Date;
      customerId: string | null;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
    }>
  >(Prisma.sql`
    SELECT r."id", r."status", r."totalPrice"::text AS "totalPrice", r."currency", r."detectedAt",
      c."id" AS "customerId", c."firstName", c."lastName", c."email"
    FROM commerce."CheckoutRecovery" r
    LEFT JOIN commerce."Customer" c ON c."id" = r."customerId" AND c."shopId" = r."shopId"
    WHERE ${cohort(shopId, query)} ${status} ${search} ${seek}
    ORDER BY r."detectedAt" ${order}, r."id" ${order} LIMIT ${query.pageSize + 1}`);
  const hasMore = rows.length > query.pageSize;
  const visible = rows.slice(0, query.pageSize);
  if (backwards) visible.reverse();
  const items = visible.map((row) => {
    const detectedAt = row.detectedAt.toISOString();
    return {
      id: row.id,
      status: row.status,
      totalPrice: row.totalPrice,
      currency: row.currency,
      detectedAt,
      customer:
        row.customerId === null
          ? null
          : {
              displayName:
                [row.firstName?.trim(), row.lastName?.trim()]
                  .filter(Boolean)
                  .join(" ") || null,
              email: row.email,
            },
      displayLabel: { kind: "checkout" as const, detectedAt },
    };
  });
  const cursor = (
    direction: "next" | "previous",
    row: { detectedAt: string; id: string },
  ) => encodeRecoveryCursor(query, shopId, { ...row, direction });
  // If concurrent changes empty a page, its original boundary still permits returning.
  return {
    items,
    previousCursor: (backwards ? hasMore : boundary !== null)
      ? cursor("previous", items[0] ?? boundary!)
      : null,
    nextCursor: (backwards ? boundary !== null : hasMore)
      ? cursor("next", items.at(-1) ?? boundary!)
      : null,
  };
}

/** Overview has no list filters and uses one consistent snapshot for both reads. */
export async function readRecoveryOverview(
  shopId: string,
  query: RecoveryQuery,
): Promise<{ summary: RecoverySummary; preview: RecoveryListRow[] }> {
  assertRecoveryQuery(query, shopId);
  decodeRecoveryCursor(query, shopId);
  const previewQuery = Object.freeze({
    ...query,
    status: "all" as const,
    q: "",
    cursor: null,
    pageSize: 5,
  });
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => ({
      summary: await readRecoveryCohortSummary(shopId, previewQuery, tx),
      preview: (await readRecoveryPage(shopId, previewQuery, tx)).items,
    }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
