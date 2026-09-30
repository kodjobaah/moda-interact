import {
  redirect,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import UsageEvents from "@/components/dashboard/UsageEvents";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { billingService } from "@/services/billing/billing.service";
import { authenticate } from "@/shopify.server";
import db from "@/db.server";
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

/** @param {{ request: Request }} args */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const embed = overviewEmbed(url, session.shop);
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  assertActiveShop(shop, {
    route: "/app/usage",
    redirectTo: "/app/merchant-support",
  });
  const settings = await db.shopSettings.findUnique({
    where: { shopId: shop.id },
  });
  const subscription = await billingService.getSubscription(shop.id);
  const state = resolveMerchantExperienceState({
    shop,
    settings,
    subscription,
  });
  if (!canAccessMerchantSurface(state, "USAGE"))
    throw redirect(
      `${getMerchantDeniedRedirect(state, "USAGE")}?${new URLSearchParams(embed)}`,
    );
  const merchantUi = merchantUiContext(settings, session);
  try {
    return {
      merchantUi,
      embed,
      history: await readUsageHistory(shop.id, url.searchParams),
    };
  } catch (error) {
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
