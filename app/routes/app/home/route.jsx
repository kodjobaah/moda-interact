import {
  redirect,
  useNavigation,
  useRevalidator,
  useRouteError,
  useLoaderData,
} from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "@/shopify.server";

import LegacyBillingUnavailable from "@/components/dashboard/LegacyBillingUnavailable";
import RecoveryOverview from "@/components/dashboard/RecoveryOverview";
import { loadOverviewPerformance, overviewEmbed } from "./overview.server";
import Onboarding from "@/components/onboarding/Onboarding";
import BillingSetupStatus from "@/components/billing-setup/BillingSetupStatus";

import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";

import { billingService } from "@/services/billing/billing.service";
import { readPendingRecoveries } from "@/services/pending-recovery/pending-recovery-reader.server";
import { merchantUiContext } from "@/utils/merchant-i18n";
import { readActiveMerchantPricingCatalogue } from "@/services/merchant-pricing/merchant-pricing.server";
import {
  buildMerchantBillingSetupState,
  shouldShowMerchantBillingSetup,
} from "@/services/billing/merchant-billing-setup-state";
import {
  canAccessMerchantSurface,
  resolveMerchantExperienceState,
} from "@/services/shop/merchant-route-access-policy";

import db from "@/db.server";

/** @param {{ request: Request }} args */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const embed = overviewEmbed(url, session.shop);
  const pendingPage = Number.parseInt(
    url.searchParams.get("pendingPage") ?? "1",
    10,
  );

  /*
   * Resolve Shopify's shop into our
   * internal tenant.
   */
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });

  assertActiveShop(shop, {
    route: "/app",
    redirectTo: "/app/merchant-support",
  });

  /*
   * ShopSettings is now related using shopId,
   * rather than the Shopify domain string.
   */
  const settings = await db.shopSettings.findUnique({
    where: {
      shopId: shop.id,
    },
  });

  const merchantUi = merchantUiContext(settings, session);
  const onboardingState = resolveMerchantExperienceState({ shop, settings });

  /*
   * The home route only polls Moda's local projection. Shopify reconciliation
   * remains a background/provider responsibility. Reading the projection before
   * the onboarding early-return lets us distinguish a genuinely fresh install
   * from a merchant who has already selected a Shopify managed-pricing option.
   */
  const [pricingCatalogue, subscriptionProjection] = await Promise.all([
    readActiveMerchantPricingCatalogue({ locale: merchantUi.locale }),
    billingService.getSubscriptionProjection(shop.id),
  ]);
  const billingSetup = shouldShowMerchantBillingSetup(
    settings?.onboardingCompleted,
    subscriptionProjection,
  )
    ? buildMerchantBillingSetupState(subscriptionProjection, pricingCatalogue)
    : null;

  /*
   * A fresh install still sees onboarding. Once durable local subscription
   * evidence exists, never send the merchant back to plan selection while the
   * Shopify subscription is being confirmed/reconciled.
   */
  if (!settings || !settings.onboardingCompleted) {
    return {
      settings,
      merchantUi,
      merchantExperienceState: onboardingState,
      pricingCatalogue,
      subscription: null,
      billingSetup,
    };
  }

  const merchantExperienceState = resolveMerchantExperienceState({
    shop,
    settings,
    subscription: subscriptionProjection,
  });
  if (
    url.searchParams.get("view") === "detail" &&
    canAccessMerchantSurface(merchantExperienceState, "USAGE")
  ) {
    const params = new URLSearchParams(embed);
    params.set(
      "bill",
      url.searchParams.get("bill") === "past" ? "past" : "current",
    );
    const billIds = url.searchParams.getAll("billId");
    if (billIds.length) {
      const billId = billIds[0];
      const period =
        billIds.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(billId)
          ? await db.billingPeriod.findFirst({
              where: { id: billId, shopId: shop.id },
              select: { id: true },
            })
          : null;
      // An explicit selection must never turn into Usage's default period.
      // Missing, foreign and malformed IDs share one safe outcome; echo none of them.
      if (!period)
        return {
          settings,
          merchantUi,
          merchantExperienceState,
          billingSetup,
          subscription: null,
          legacyBillingUnavailable: true,
          embed,
        };
      params.set("billId", period.id);
    }
    throw redirect(`/app/usage?${params}`);
  }
  const [capacity, performance] = await Promise.all([
    billingService.getMerchantRecoveryCapacityState(shop.id).catch(() => null),
    loadOverviewPerformance(shop.id, url, merchantUi, embed),
  ]);

  const subscriptionState = subscriptionProjection ?? {
    status:
      capacity?.availability === "CONTRACT_FROZEN" ? "FROZEN" : "NO_CONTRACT",
    plan: null,
    observedShopifyPlanHandle: capacity?.observedShopifyPlanHandle,
  };

  const pendingRecoveries = canAccessMerchantSurface(
    merchantExperienceState,
    "PENDING_RECOVERIES",
  )
    ? await readPendingRecoveries({
        shopId: shop.id,
        shopDomain: shop.domain,
        page: pendingPage,
      })
    : {
        available: false,
        page: 1,
        pageSize: 10,
        total: 0,
        totalPages: 0,
        items: [],
      };

  return {
    settings,
    merchantUi,
    merchantExperienceState,
    pricingCatalogue,
    billingSetup,

    subscription: subscriptionState
      ? {
          status: subscriptionState.status,

          planHandle: subscriptionState.observedShopifyPlanHandle,

          planName:
            subscriptionState.plan?.name ??
            subscriptionState.observedShopifyPlanHandle,
          cancelAtEndOfCycle:
            subscriptionProjection?.cancelAtPeriodEnd ?? false,
          currentPeriodEnd:
            subscriptionProjection?.currentPeriodEnd?.toISOString() ?? null,
          pendingPlan: subscriptionProjection?.pendingPlan
            ? {
                name: subscriptionProjection.pendingPlan.name,
                effectiveAt:
                  subscriptionProjection.pendingEffectiveAt?.toISOString() ??
                  null,
              }
            : null,
        }
      : null,
    capacity,

    performance,
    pendingRecoveries,
    pendingRecoveriesUpdatedAt: pendingRecoveries.available
      ? new Date().toISOString()
      : null,
  };
};

export default function Index() {
  const data = useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  if (
    data.merchantExperienceState === "ONBOARDING" ||
    !data.settings?.onboardingCompleted
  ) {
    return data.billingSetup ? (
      <BillingSetupStatus
        merchantUi={data.merchantUi}
        setup={data.billingSetup}
        standalone
      />
    ) : (
      <Onboarding
        merchantUi={data.merchantUi}
        pricingCatalogue={data.pricingCatalogue}
      />
    );
  }
  if (data.legacyBillingUnavailable) {
    return (
      <LegacyBillingUnavailable
        merchantUi={data.merchantUi}
        embed={data.embed}
      />
    );
  }
  return (
    <RecoveryOverview
      {...data}
      busy={navigation.state !== "idle" || revalidator.state !== "idle"}
      onRefresh={() => revalidator.revalidate()}
    />
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (
  /** @type {import("react-router").HeadersArgs} */ headersArgs,
) => {
  return boundary.headers(headersArgs);
};
