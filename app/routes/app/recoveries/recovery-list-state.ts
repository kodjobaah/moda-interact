import type {
  RecoveryFilter,
  RecoveryQuery,
} from "../../../services/recoveries/recovery-query.server";
import type { RecoveryPage } from "../../../services/recoveries/recovery-readers.server";

export type ListFilters = Pick<
  RecoveryQuery,
  "from" | "to" | "status" | "q" | "pageSize" | "cursor"
>;
export type EmbedContext = { shop: string; host?: string; embedded?: string };
export type RecoveryListData = {
  merchantUi: { locale: string; timeZone: string; fallbackLocale: string };
  filters: ListFilters;
  embed: EmbedContext;
  today: string;
  presets: { today: string; week: string; month: string };
  page: RecoveryPage;
  state: "ready" | "never-used" | "empty" | "error" | "invalid";
  error: "date" | "filter" | "search" | "cursor" | null;
};
export const listStatuses: RecoveryFilter[] = [
  "all",
  "ongoing",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
];

/** Only explicit embed/navigation fields are retained; never tokens, returnTo or shopId. */
export function recoveryListUrl(
  filters: ListFilters,
  embed: EmbedContext,
  cursor: string | null = filters.cursor,
): string {
  const search = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    status: filters.status,
    q: filters.q,
    pageSize: String(filters.pageSize),
    shop: embed.shop,
  });
  if (embed.host) search.set("host", embed.host);
  if (embed.embedded) search.set("embedded", embed.embedded);
  if (cursor) search.set("cursor", cursor);
  return `/app/recoveries?${search}`;
}
