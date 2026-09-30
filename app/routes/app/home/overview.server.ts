import {
  normalizeRecoveryQuery,
  RecoveryQueryError,
} from "../../../services/recoveries/recovery-query.server";
import { readRecoveryOverview } from "../../../services/recoveries/recovery-readers.server";
import type { EmbedContext } from "../recoveries/recovery-list-state";
type MerchantUiContext = {
  locale: string;
  timeZone: string;
  fallbackLocale?: string;
};

export function overviewEmbed(url: URL, shop: string): EmbedContext {
  const embed: EmbedContext = { shop };
  const host = url.searchParams.get("host");
  if (host && /^[A-Za-z0-9+/_=-]{1,512}$/.test(host)) embed.host = host;
  if (url.searchParams.get("embedded") === "1") embed.embedded = "1";
  return embed;
}
export async function loadOverviewPerformance(
  shopId: string,
  url: URL,
  merchantUi: MerchantUiContext,
  embed: EmbedContext,
  now = new Date(),
) {
  const defaults = normalizeRecoveryQuery(
    new URLSearchParams(),
    merchantUi,
    now,
  );
  const dates = new URLSearchParams();
  for (const key of ["from", "to"])
    for (const value of url.searchParams.getAll(key)) dates.append(key, value);
  let query = defaults;
  let state: "ready" | "invalid" | "error" = "ready";
  let overview: Awaited<ReturnType<typeof readRecoveryOverview>> | null = null;
  try {
    query = normalizeRecoveryQuery(dates, merchantUi, now);
  } catch (error) {
    if (!(error instanceof RecoveryQueryError)) throw error;
    state = "invalid";
  }
  if (state === "ready") {
    try {
      overview = await readRecoveryOverview(shopId, query);
    } catch {
      state = "error";
    }
  }
  return {
    state,
    overview,
    embed,
    filters: {
      from:
        state === "invalid"
          ? (dates.get("from") ?? defaults.from).slice(0, 10)
          : query.from,
      to:
        state === "invalid"
          ? (dates.get("to") ?? defaults.to).slice(0, 10)
          : query.to,
      status: "all" as const,
      q: "",
      pageSize: 25,
      cursor: null,
    },
    today: defaults.to,
    presets: {
      today: defaults.to,
      month: defaults.from,
      week: new Date(Date.parse(`${defaults.to}T00:00:00Z`) - 6 * 86400000)
        .toISOString()
        .slice(0, 10),
    },
  };
}
