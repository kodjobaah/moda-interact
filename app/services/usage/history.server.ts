import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
const db: PrismaClient = prisma;

const metric = "RECOVERY_CONVERSATION" as const;
const periodSelect = {
  id: true,
  status: true,
  periodStart: true,
  periodEnd: true,
} as const;
const scope = (shopId: string, view: string) =>
  createHash("sha256")
    .update(JSON.stringify([shopId, view]))
    .digest("hex");
export class UsageCursorError extends Error {}
type Boundary = {
  v: 1;
  scope: string;
  start: string;
  id: string;
  direction: "next" | "previous";
};
function decode(
  token: string | null,
  shopId: string,
  view: string,
): Boundary | null {
  if (token === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new Error();
    const raw = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(raw).toString("base64url") !== token) throw new Error();
    const value = JSON.parse(raw);
    if (
      Object.keys(value).sort().join(",") !== "direction,id,scope,start,v" ||
      value.v !== 1 ||
      value.scope !== scope(shopId, view) ||
      !["next", "previous"].includes(value.direction) ||
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
      typeof value.start !== "string" ||
      new Date(value.start).toISOString() !== value.start
    )
      throw new Error();
    return value;
  } catch {
    throw new UsageCursorError("Invalid billing period cursor");
  }
}
function encode(
  period: { id: string; periodStart: Date },
  direction: Boundary["direction"],
  shopId: string,
  view: string,
) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scope: scope(shopId, view),
      start: period.periodStart.toISOString(),
      id: period.id,
      direction,
    }),
  ).toString("base64url");
}
export type SourceRecovery = {
  recoveryId: string;
  detectedAt: string;
  customerName: string | null;
};
/** Three indexed source-ID branches; no history hydration or message-body projection. */
export async function readUsageSources(
  shopId: string,
  ids: string[],
): Promise<Map<string, SourceRecovery>> {
  if (!ids.length) return new Map();
  if (ids.length > 100) throw new Error("Usage page exceeds source limit");
  const sourceIds = Prisma.join([...new Set(ids)]);
  const rows = await db.$queryRaw<
    Array<{
      sourceId: string;
      recoveryId: string;
      detectedAt: Date;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
    }>
  >(Prisma.sql`
    WITH sources AS (
      SELECT r."id" AS "sourceId", r."id" AS "recoveryId", r."detectedAt", r."customerId"
      FROM commerce."CheckoutRecovery" r WHERE r."shopId" = ${shopId} AND r."id" IN (${sourceIds})
      UNION ALL
      SELECT c."id", r."id", r."detectedAt", r."customerId"
      FROM whatsapp."Conversation" c JOIN commerce."CheckoutRecovery" r ON r."id" = c."checkoutRecoveryId" AND r."shopId" = ${shopId}
      WHERE c."id" IN (${sourceIds}) AND (c."shopId" IS NULL OR c."shopId" = ${shopId})
      UNION ALL
      SELECT m."id", r."id", r."detectedAt", r."customerId"
      FROM whatsapp."ConversationMessage" m JOIN whatsapp."Conversation" c ON c."id" = m."conversationId"
      JOIN commerce."CheckoutRecovery" r ON r."id" = c."checkoutRecoveryId" AND r."shopId" = ${shopId}
      WHERE m."id" IN (${sourceIds}) AND (c."shopId" IS NULL OR c."shopId" = ${shopId})
    )
    SELECT s."sourceId", s."recoveryId", s."detectedAt", c."firstName", c."lastName", c."email"
    FROM sources s LEFT JOIN commerce."Customer" c ON c."id" = s."customerId" AND c."shopId" = ${shopId}
    LIMIT 300`);
  const grouped = new Map<string, typeof rows>();
  for (const row of rows)
    grouped.set(row.sourceId, [...(grouped.get(row.sourceId) ?? []), row]);
  const result = new Map<string, SourceRecovery>();
  for (const [id, matches] of grouped) {
    if (new Set(matches.map((row) => row.recoveryId)).size !== 1) continue;
    const row = matches[0];
    result.set(id, {
      recoveryId: row.recoveryId,
      detectedAt: row.detectedAt.toISOString(),
      customerName:
        [row.firstName?.trim(), row.lastName?.trim()]
          .filter(Boolean)
          .join(" ") ||
        row.email ||
        null,
    });
  }
  return result;
}
export async function readUsageHistory(
  shopId: string,
  params: URLSearchParams,
) {
  const view =
    params.get("bill") === "past" ? ("past" as const) : ("current" as const);
  const pageSizeInput = Number(params.get("pageSize"));
  const pageSize = [10, 25, 50, 100].includes(pageSizeInput)
    ? pageSizeInput
    : 10;
  const pageInput = Number(params.get("page"));
  // Prisma offset is a signed integer. Never overflow it for untrusted page input.
  const page =
    Number.isSafeInteger(pageInput) &&
    pageInput > 0 &&
    (pageInput - 1) * pageSize <= 2147483647
      ? pageInput
      : 1;
  if (params.getAll("periodCursor").length > 1) throw new UsageCursorError();
  const boundary = decode(params.get("periodCursor"), shopId, view);
  const ids = params.getAll("billId");
  const validId = ids.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(ids[0]);
  const status = view === "past" ? ("CLOSED" as const) : ("OPEN" as const);
  const selected = ids.length
    ? validId
      ? await db.billingPeriod.findFirst({
          where: { shopId, id: ids[0] },
          select: periodSelect,
        })
      : null
    : await db.billingPeriod.findFirst({
        where: { shopId, status },
        orderBy: [{ periodStart: "desc" }, { id: "desc" }],
        select: periodSelect,
      });
  const backwards = boundary?.direction === "previous";
  const seek = !boundary
    ? {}
    : {
        OR: [
          {
            periodStart: {
              [backwards ? "gt" : "lt"]: new Date(boundary.start),
            },
          },
          {
            periodStart: new Date(boundary.start),
            id: { [backwards ? "gt" : "lt"]: boundary.id },
          },
        ],
      };
  const periods = await db.billingPeriod.findMany({
    where: { shopId, status, ...seek },
    select: periodSelect,
    orderBy: [
      { periodStart: backwards ? "asc" : "desc" },
      { id: backwards ? "asc" : "desc" },
    ],
    take: 26,
  });
  const hasMore = periods.length > 25;
  const visible = periods.slice(0, 25);
  if (backwards) visible.reverse();
  const first =
    visible[0] ??
    (boundary
      ? { id: boundary.id, periodStart: new Date(boundary.start) }
      : null);
  const last = visible.at(-1) ?? first;
  const periodPage = {
    items: visible.map((p) => ({
      ...p,
      periodStart: p.periodStart.toISOString(),
      periodEnd: p.periodEnd.toISOString(),
    })),
    previousCursor:
      first && (backwards ? hasMore : !!boundary)
        ? encode(first, "previous", shopId, view)
        : null,
    nextCursor:
      last && (backwards ? !!boundary : hasMore)
        ? encode(last, "next", shopId, view)
        : null,
  };
  const where = { shopId, billingPeriodId: selected?.id, metric };
  const [events, total, aggregate] = selected
    ? await Promise.all([
        db.usageEvent.findMany({
          where,
          select: {
            id: true,
            metric: true,
            quantity: true,
            idempotencyKey: true,
            sourceType: true,
            sourceId: true,
            occurredAt: true,
          },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        db.usageEvent.count({ where }),
        db.usageEvent.aggregate({ where, _sum: { quantity: true } }),
      ])
    : [[], 0, { _sum: { quantity: null } }];
  const sources = await readUsageSources(
    shopId,
    events.flatMap((event) => (event.sourceId ? [event.sourceId] : [])),
  );
  return {
    state:
      ids.length && !selected ? ("unavailable" as const) : ("ready" as const),
    usageView: view,
    periodPage,
    usageEvents: events.map((event) => ({
      id: event.id,
      metric: event.metric,
      quantity: Number(event.quantity),
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAt.toISOString(),
      sourceRecovery: event.sourceId
        ? (sources.get(event.sourceId) ?? null)
        : null,
    })),
    usagePagination: {
      page,
      pageSize,
      total,
      totalQuantity: Number(aggregate._sum?.quantity ?? 0),
      billId: selected?.id ?? null,
      periodStart: selected?.periodStart.toISOString() ?? null,
      periodEnd: selected?.periodEnd.toISOString() ?? null,
    },
    // Preserve only validated selectors. Unavailable selections remain explicit on pagination links.
    selection: ids.length
      ? selected
        ? { billId: selected.id }
        : { billId: "" }
      : {},
    periodCursor: params.get("periodCursor"),
  };
}
