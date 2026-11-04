import {
  RouterContextProvider,
  redirect,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import UsageEvents from "@/components/dashboard/UsageEvents";
import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { logBillingBoundaryFailure } from "@/services/billing/providers/shopify-billing-diagnostics.server";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { merchantUiContext } from "@/utils/merchant-i18n";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "@/services/shop/merchant-route-access-policy";
import {
  readUsageHistory,
  UsageCursorError,
} from "@/services/usage/history.server";
import { overviewEmbed } from "../home/overview.server";

/** @param {{ request: Request, context?: Readonly<import("react-router").RouterContextProvider> }} args */
export const loader = async ({ request, context = new RouterContextProvider() }) => {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { session } } = merchant;
  const url = new URL(request.url);
  const embed = overviewEmbed(url, session.shop);
  assertActiveShop(shop, {
    route: "/app/usage",
    redirectTo: "/app/merchant-support",
  });
  const scalar = await merchant.readSubscription();
  const subscription = scalar && ["ACTIVE", "TRIALING"].includes(scalar.status) ? scalar : null;
  const state = resolveMerchantExperienceState({
    shop,
    subscription,
  });
  if (!canAccessMerchantSurface(state, "USAGE"))
    throw redirect(
      `${getMerchantDeniedRedirect(state, "USAGE")}?${new URLSearchParams(embed)}`,
    );
  const merchantUi = merchantUiContext(shop, session);
  try {
    return {
      merchantUi,
      embed,
      history: await readUsageHistory(shop.id, url.searchParams),
    };
  } catch (error) {
    if (!(error instanceof UsageCursorError)) logBillingBoundaryFailure({ event: "shopify.usage.read_failed", operation: "read_usage_history", stage: "read_history", shopId: shop.id, error });
    return {
      merchantUi,
      embed,
      history: null,
      error: error instanceof UsageCursorError ? "cursor" : "read",
    };
  }
};
export default function UsagePage() {
  const data = useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  return (
    <UsageEvents
      {...data}
      busy={navigation.state !== "idle" || revalidator.state !== "idle"}
      onRefresh={() => revalidator.revalidate()}
    />
  );
}
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
/** @param {import("react-router").HeadersArgs} args */
export const headers = (args) => boundary.headers(args);
