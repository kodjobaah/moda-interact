import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { shopifyPeriodUsageWhere } from "./period-scope";
import { readUsageSources } from "./sources.server";
import { isCreditSource, readUnifiedLedger, type ChargedAgainst, type CreditSource } from "./unified-ledger";
export { readUsageSources, type SourceRecovery } from "./sources.server";

type UsageHistoryDatabase = Pick<PrismaClient, "billingPeriod" | "usageEvent" | "$queryRaw">;
const db: UsageHistoryDatabase = prisma;
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
type HistoryEvent = { id: string; metric: string; quantity: number; occurredAt: string;
  sourceRecovery: import("./sources.server").SourceRecovery | null; chargedAgainst?: ChargedAgainst; idempotencyKey?: string };
type History = {
  state: "ready" | "unavailable"; usageView: "current" | "past" | "all"; chargeSource?: CreditSource;
  periodPage: { items: Array<{ id: string; status: string; periodStart: string; periodEnd: string }>; previousCursor: string | null; nextCursor: string | null };
  usageEvents: HistoryEvent[];
  usagePagination: { page: number; pageSize: number; total: number; totalQuantity: number; billId: string | null; periodStart: string | null; periodEnd: string | null };
  selection: { billId?: string }; periodCursor: string | null;
};
export async function readUsageHistory(
  shopId: string,
  params: URLSearchParams,
  database: UsageHistoryDatabase = db,
): Promise<History> {
  const view =
    params.get("bill") === "all" ? ("all" as const) :
    params.get("bill") === "past" ? ("past" as const) : ("current" as const);
  const unified = view === "all" || params.has("chargeSource");
  const source = params.get("chargeSource") ?? "ALL";
  if (params.getAll("chargeSource").length > 1 || !isCreditSource(source))
    throw new UsageCursorError("Invalid credit source");
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
  if (view === "all") {
    if (params.has("billId") || params.has("periodCursor"))
      throw new UsageCursorError("All-time usage cannot select a period");
    const ledger = await readUnifiedLedger(database, { shopId, provider: "SHOPIFY",
      source, page, pageSize, period: null });
    const sources = await readUsageSources(shopId, ledger.events.map(event => event.id), database);
    return {
      state: "ready" as const, usageView: view, chargeSource: source,
      periodPage: { items: [], previousCursor: null, nextCursor: null },
      usageEvents: ledger.events.map(event => ({
        id: event.id, metric: event.metric, quantity: event.quantity,
        occurredAt: event.occurredAt.toISOString(), chargedAgainst: event.chargedAgainst,
        sourceRecovery: sources.get(event.id) ?? null,
      })),
      usagePagination: { page, pageSize, total: ledger.total, totalQuantity: ledger.totalQuantity,
        billId: null, periodStart: null, periodEnd: null },
      selection: {} as { billId?: string }, periodCursor: null,
    };
  }
  const boundary = decode(params.get("periodCursor"), shopId, view);
  const ids = params.getAll("billId");
  const validId = ids.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(ids[0]);
  const status = view === "past" ? ("CLOSED" as const) : ("OPEN" as const);
  const selected = ids.length
    ? validId
      ? await database.billingPeriod.findFirst({
          where: { shopId, id: ids[0], ...(unified ? { status } : {}) },
          select: periodSelect,
        })
      : null
    : await database.billingPeriod.findFirst({
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
  const periods = await database.billingPeriod.findMany({
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
  if (unified && selected) {
    const ledger = await readUnifiedLedger(database, { shopId, provider: "SHOPIFY",
      source, page, pageSize, period: selected });
    const sources = await readUsageSources(shopId, ledger.events.map(event => event.id), database);
    return {
      state: "ready" as const, usageView: view, chargeSource: source, periodPage,
      usageEvents: ledger.events.map(event => ({
        id: event.id, metric: event.metric, quantity: event.quantity,
        occurredAt: event.occurredAt.toISOString(), chargedAgainst: event.chargedAgainst,
        sourceRecovery: sources.get(event.id) ?? null,
      })),
      usagePagination: { page, pageSize, total: ledger.total, totalQuantity: ledger.totalQuantity,
        billId: selected.id, periodStart: selected.periodStart.toISOString(), periodEnd: selected.periodEnd.toISOString() },
      selection: ids.length ? { billId: selected.id } : {} as { billId?: string },
      periodCursor: params.get("periodCursor"),
    };
  }
  const where = selected ? shopifyPeriodUsageWhere(shopId, selected) : null;
  const [events, aggregate] = where
    ? await Promise.all([
        database.usageEvent.findMany({
          where,
          select: {
            id: true,
            metric: true,
            quantity: true,
            idempotencyKey: true,
            occurredAt: true,
          },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        database.usageEvent.aggregate({ where, _count: { _all: true }, _sum: { quantity: true } }),
      ])
    : [[], { _count: { _all: 0 }, _sum: { quantity: null } }];
  const sources = await readUsageSources(
    shopId,
    events.map((event) => event.id),
    database,
  );
  return {
    state:
      (ids.length || (unified && view === "current")) && !selected ? ("unavailable" as const) : ("ready" as const),
    usageView: view,
    ...(unified ? { chargeSource: source } : {}),
    periodPage,
    usageEvents: events.map((event) => ({
      id: event.id,
      metric: event.metric,
      quantity: Number(event.quantity),
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAt.toISOString(),
      sourceRecovery: sources.get(event.id) ?? null,
    })),
    usagePagination: {
      page,
      pageSize,
      total: aggregate._count._all,
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
