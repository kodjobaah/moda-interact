import type {
  readRecoveryDetail,
  readRecoveryMessages,
  readRelatedRecoveries,
} from "../../../services/recoveries/recovery-detail.server";
import {
  recoveryListUrl,
  type ListFilters,
  type EmbedContext,
} from "../recoveries/recovery-list-state";
export type Detail = NonNullable<
  Awaited<ReturnType<typeof readRecoveryDetail>>
>;
export type Messages = NonNullable<
  Awaited<ReturnType<typeof readRecoveryMessages>>
>;
export type Related = NonNullable<
  Awaited<ReturnType<typeof readRelatedRecoveries>>
>;
export type Section<T> = {
  state: "ready" | "error" | "invalid" | "unavailable";
  page: T | null;
};
export type DetailData = {
  merchantUi: { locale: string; timeZone: string; fallbackLocale: string };
  embed: EmbedContext;
  filters: ListFilters;
  detail: Detail | null;
  state: "ready" | "error" | "unavailable";
  messages: Section<Messages>;
  related: Section<Related>;
};
export function recoveryDetailUrl(
  id: string,
  filters: ListFilters,
  embed: EmbedContext,
) {
  return recoveryListUrl(filters, embed).replace(
    "/app/recoveries?",
    `/app/recoveries/${encodeURIComponent(id)}?`,
  );
}
export function sectionUrl(
  id: string,
  kind: "messages" | "related",
  embed: EmbedContext,
  cursor?: string | null,
  latest = false,
) {
  const params = new URLSearchParams(embed);
  if (cursor) params.set("cursor", cursor);
  if (latest) params.set("window", "latest");
  return `/app/recoveries/${encodeURIComponent(id)}/${kind}?${params}`;
}
