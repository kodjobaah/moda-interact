import { createHash } from "node:crypto";
import { CheckoutRecoveryStatus } from "@prisma/client";
import { merchantUiContext } from "../../utils/merchant-i18n.js";

export type RecoveryFilter =
  "all" | "ongoing" | "COMPLETED" | "EXPIRED" | "CANCELLED";
export type RecoveryQueryErrorCode =
  | "invalid_date"
  | "reversed_range"
  | "future_date"
  | "range_too_long"
  | "invalid_filter"
  | "invalid_search"
  | "invalid_page_size"
  | "invalid_cursor";
/** Stable codes for callers to localize; never render the exception message. */
export class RecoveryQueryError extends Error {
  constructor(public readonly code: RecoveryQueryErrorCode) {
    super(code);
  }
}
const fail = (code: RecoveryQueryErrorCode): never => {
  throw new RecoveryQueryError(code);
};
const DAY = 86_400_000;
const normalized = Symbol("normalized recovery query");
export type RecoveryQuery = Readonly<{
  [normalized]: true;
  from: string;
  to: string;
  timeZone: string;
  start: string;
  end: string;
  status: RecoveryFilter;
  q: string;
  pageSize: number;
  cursor: string | null;
}>;

function calendarDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail("invalid_date");
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value ||
    value < "0001-01-01" ||
    value > "9998-12-31"
  )
    return fail("invalid_date");
  return timestamp;
}
function shiftDate(date: string, days: number): string {
  return new Date(calendarDate(date) + days * DAY).toISOString().slice(0, 10);
}
function localDate(timestamp: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(timestamp);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}
/** First instant of a calendar date, including midnight DST gaps/overlaps.
 * A skipped calendar date resolves to the start of the next extant date.
 * Calendar labels, rather than elapsed 24h, determine both boundaries.
 */
function startOfDate(date: string, formatter: Intl.DateTimeFormat): string {
  const nominal = calendarDate(date);
  let low = nominal - 2 * DAY,
    high = nominal + 2 * DAY;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle, formatter) < date) low = middle + 1;
    else high = middle;
  }
  return new Date(low).toISOString();
}

export function normalizeRecoveryQuery(
  input: URLSearchParams,
  merchantUi: { timeZone?: string },
  now = new Date(),
): RecoveryQuery {
  // Reuse the existing merchant zone validation and UTC fallback.
  const { timeZone } = merchantUiContext({
    defaultTimeZone: merchantUi.timeZone,
  });
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = localDate(now.getTime(), formatter);
  const from = input.get("from") ?? shiftDate(today, -29);
  const to = input.get("to") ?? today;
  const span = (calendarDate(to) - calendarDate(from)) / DAY + 1;
  if (span < 1) return fail("reversed_range");
  if (to > today) return fail("future_date");
  if (span > 366) return fail("range_too_long");
  const status = input.get("status") ?? "all";
  if (!["all", "ongoing", "COMPLETED", "EXPIRED", "CANCELLED"].includes(status))
    return fail("invalid_filter");
  const rawSearch = input.get("q") ?? "";
  if (rawSearch.length > 1000) return fail("invalid_search");
  const q = rawSearch.trim();
  if (Array.from(q).length > 100 || q.includes("\0"))
    return fail("invalid_search");
  const size = input.get("pageSize") ?? "25";
  if (!/^[1-9]\d?$/.test(size) || Number(size) > 50)
    return fail("invalid_page_size");
  const cursor = input.get("cursor");
  if (
    cursor !== null &&
    (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024)
  )
    return fail("invalid_cursor");
  return Object.freeze({
    [normalized]: true as const,
    from,
    to,
    timeZone,
    start: startOfDate(from, formatter),
    end: startOfDate(shiftDate(to, 1), formatter),
    status: status as RecoveryFilter,
    q,
    pageSize: Number(size),
    cursor,
  });
}

export function assertRecoveryQuery(
  query: RecoveryQuery,
  shopId: string,
): void {
  if (!query[normalized] || !shopId)
    throw new Error(
      "Authenticated shop and normalized recovery query required",
    );
}
export const ongoingStatuses = [
  CheckoutRecoveryStatus.DETECTED,
  CheckoutRecoveryStatus.MESSAGE_SENT,
  CheckoutRecoveryStatus.ENGAGED,
];

type Boundary = {
  direction: "next" | "previous";
  detectedAt: string;
  id: string;
};
function binding(query: RecoveryQuery, shopId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        shopId,
        query.from,
        query.to,
        query.timeZone,
        query.start,
        query.end,
        query.status,
        query.q,
        query.pageSize,
      ]),
    )
    .digest("hex");
}
export function encodeRecoveryCursor(
  query: RecoveryQuery,
  shopId: string,
  boundary: Boundary,
): string {
  return Buffer.from(
    JSON.stringify([
      1,
      binding(query, shopId),
      boundary.direction,
      boundary.detectedAt,
      boundary.id,
    ]),
  ).toString("base64url");
}
export function decodeRecoveryCursor(
  query: RecoveryQuery,
  shopId: string,
): Boundary | null {
  if (query.cursor === null) return null;
  try {
    const bytes = Buffer.from(query.cursor, "base64url");
    if (bytes.toString("base64url") !== query.cursor)
      return fail("invalid_cursor");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(value) || value.length !== 5)
      return fail("invalid_cursor");
    const [version, hash, direction, detectedAt, id] = value;
    if (
      version !== 1 ||
      hash !== binding(query, shopId) ||
      !["next", "previous"].includes(direction) ||
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,191}$/.test(id) ||
      typeof detectedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(detectedAt) ||
      new Date(detectedAt).toISOString() !== detectedAt ||
      detectedAt < query.start ||
      detectedAt >= query.end
    )
      return fail("invalid_cursor");
    return { direction, detectedAt, id };
  } catch {
    return fail("invalid_cursor");
  }
}
