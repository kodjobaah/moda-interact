import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../../../shopify.server";
import { shopService } from "../../../services/shop/shop.service";
import { billingService } from "../../../services/billing/billing.service";
import db from "../../../db.server";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "../../../services/shop/merchant-route-access-policy";
import { merchantUiContext } from "../../../utils/merchant-i18n";
import {
  normalizeRecoveryQuery,
  decodeRecoveryCursor,
  RecoveryQueryError,
} from "../../../services/recoveries/recovery-query.server";
import { readRecoveryPage } from "../../../services/recoveries/recovery-readers.server";
import {
  type EmbedContext,
  type ListFilters,
  type RecoveryListData,
} from "./recovery-list-state";

export async function loadRecoveryList({
  request,
}: LoaderFunctionArgs): Promise<RecoveryListData> {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  const url = new URL(request.url);
  const embed: EmbedContext = { shop: session.shop };
  const host = url.searchParams.get("host");
  if (host && /^[A-Za-z0-9+/_=-]{1,512}$/.test(host)) embed.host = host;
  if (url.searchParams.get("embedded") === "1") embed.embedded = "1";
  // Resolve lifecycle before recovery reads, even when this loader runs without its parent.
  // Inactive shops need no settings/subscription query to determine denial.
  const settings =
    shop.status === "ACTIVE"
      ? await db.shopSettings.findUnique({ where: { shopId: shop.id } })
      : null;
  const subscription =
    shop.status === "ACTIVE"
      ? await billingService.getSubscription(shop.id)
      : null;
  const state = resolveMerchantExperienceState({
    shop,
    settings,
    subscription,
  });
  if (!canAccessMerchantSurface(state, "RECOVERY_HISTORY")) {
    const destination = getMerchantDeniedRedirect(state, "RECOVERY_HISTORY");
    throw redirect(`${destination}?${new URLSearchParams(embed)}`);
  }
  const merchantUi = merchantUiContext(settings, session);
  const now = new Date();
  const defaults = normalizeRecoveryQuery(
    new URLSearchParams(),
    merchantUi,
    now,
  );
  const shift = (days: number) =>
    new Date(Date.parse(`${defaults.to}T00:00:00Z`) - days * 86400000)
      .toISOString()
      .slice(0, 10);
  const view = (query: ListFilters): ListFilters => ({
    from: query.from,
    to: query.to,
    status: query.status,
    q: query.q,
    pageSize: query.pageSize,
    cursor: query.cursor,
  });
  const result: RecoveryListData = {
    merchantUi,
    filters: view(defaults),
    embed,
    today: defaults.to,
    presets: { today: defaults.to, week: shift(6), month: defaults.from },
    page: { items: [], previousCursor: null, nextCursor: null },
    state: "ready",
    error: null,
  };
  let query;
  try {
    query = normalizeRecoveryQuery(url.searchParams, merchantUi, now);
    result.filters = view(query);
    decodeRecoveryCursor(query, shop.id);
  } catch (error) {
    if (!(error instanceof RecoveryQueryError)) throw error;
    // Keep bounded user input editable; never echo arbitrary query parameters or cursors.
    const input = url.searchParams;
    if (!query) {
      result.filters = {
        ...result.filters,
        from: (input.get("from") ?? defaults.from).slice(0, 10),
        to: (input.get("to") ?? defaults.to).slice(0, 10),
        q: (input.get("q") ?? "").slice(0, 100),
      };
    }
    result.filters = { ...result.filters, cursor: null };
    result.state = "invalid";
    result.error =
      error.code === "invalid_cursor"
        ? "cursor"
        : error.code === "invalid_search"
          ? "search"
          : ["invalid_filter", "invalid_page_size"].includes(error.code)
            ? "filter"
            : "date";
    return result;
  }
  try {
    result.page = await readRecoveryPage(shop.id, query);
    if (!result.page.items.length) {
      // A single indexed existence lookup distinguishes no history from an empty range.
      const exists = await db.checkoutRecovery.findFirst({
        where: { shopId: shop.id },
        select: { id: true },
      });
      result.state = exists ? "empty" : "never-used";
    }
  } catch {
    // Recovery errors keep filters/embed context, without exposing raw DB/provider data.
    result.state = "error";
  }
  return result;
}
