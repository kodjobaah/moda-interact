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

/** Share the loader-validated identity with detail's Back link, not the raw URL.
 * Equivalent default/ordered URLs must save and restore the same list position.
 * Invalid/loading routes and all other pages keep React Router's entry identity.
 */
export function recoveryScrollKey(
  location: { pathname: string; key: string; state?: unknown },
  matches: readonly { pathname: string; data: unknown }[],
): string {
  if (location.pathname !== "/app/recoveries") return location.key;
  const match = matches.find((item) => item.pathname === "/app/recoveries");
  const list = match?.data as RecoveryListData | undefined;
  if (list?.filters && list.embed) {
    return list.state === "invalid"
      ? location.key
      : recoveryListUrl(list.filters, list.embed);
  }
  // React Router looks up the destination position using the previous loaderData.
  // Back carries this UI-only key, generated from the detail loader's validated
  // filters. It is never used as a navigation target or authorization input.
  const state = location.state as { recoveryListScrollKey?: unknown } | null;
  const savedKey = state?.recoveryListScrollKey;
  return typeof savedKey === "string" &&
    savedKey.startsWith("/app/recoveries?") &&
    savedKey.length <= 8192
    ? savedKey
    : location.key;
}
