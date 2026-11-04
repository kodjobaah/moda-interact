import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import { overviewEmbed } from "../../home/overview.server";
import BillingPurchaseHub from "@/components/dashboard/BillingPurchaseHub";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";
import { billingService } from "@/services/billing/billing.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "@/services/shop/merchant-route-access-policy";
import { logBillingBoundaryFailure } from "@/services/billing/providers/shopify-billing-diagnostics.server";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "@/services/otel/otel.runtime";
import { SubscriptionProjectionStatus } from "@prisma/client";

const logger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});

function durableLifecycleState(
  subscription: import("@prisma/client").Subscription | null,
) {
  switch (subscription?.status) {
    case SubscriptionProjectionStatus.ACTIVE:
    case SubscriptionProjectionStatus.TRIALING:
      return "ACTIVE" as const;
    case SubscriptionProjectionStatus.FROZEN:
      return "FROZEN" as const;
    case SubscriptionProjectionStatus.NO_CONTRACT:
      return subscription.lastProviderLifecycleState === "CANCELED"
        ? "POST_CONTRACT" as const
        : "NO_ACTIVE_SUBSCRIPTION" as const;
    default:
      return "UNRESOLVED" as const;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { session } } = merchant;
  const url = new URL(request.url);
  assertActiveShop(shop, {
    route: "/app/billing/options",
    capability: "manage-billing",
    redirectTo: "/app/merchant-support",
  });
  const subscription = await merchant.readSubscription();
  const merchantExperienceState = resolveMerchantExperienceState({
    shop,
    subscription,
  });
  let currentContract: Awaited<ReturnType<typeof billingService.readMerchantBillingPresentation>>["currentContract"] = null;
  if (!canAccessMerchantSurface(merchantExperienceState, "BILLING_OPTIONS"))
    throw new Response(null, {
      status: 302,
      headers: {
        Location: getMerchantDeniedRedirect(
          merchantExperienceState,
          "BILLING_OPTIONS",
        ),
      },
    });
  const usageHistoryAvailable = canAccessMerchantSurface(
    merchantExperienceState,
    "USAGE",
  );
  const usageHistoryHref = `/app/usage?${new URLSearchParams(overviewEmbed(url, session.shop))}`;
  const purchaseHistoryAvailable = canAccessMerchantSurface(
    merchantExperienceState,
    "BILLING_PURCHASE_HISTORY",
  );
  const merchantUi = merchantUiContext(shop, session);

  try {
    const presentation = await billingService.readMerchantBillingPresentation({ shop, subscription, now: new Date() });
    const { commercial, capacity, topUp } = presentation;
    currentContract = presentation.currentContract;

    const lifecycleState = durableLifecycleState(subscription);
    const verificationState =
      lifecycleState === "FROZEN"
        ? "FROZEN"
        : (commercial?.status ?? "VERIFICATION_UNAVAILABLE");
    const requestedPlanHandle =
      url.searchParams.get("requested_plan_handle")?.trim() ?? "";
    const planChange = url.searchParams.get("plan_change");
    const providerCurrentHandle = commercial?.subscription?.planHandle ?? null;
    const providerPendingHandle =
      commercial?.subscription?.pendingUpdate?.planHandle ?? null;
    const scheduledCancellation =
      commercial?.status === "ACTIVE_SUBSCRIPTION" &&
      commercial.subscription.cancelAtEndOfCycle &&
      !commercial.subscription.pendingUpdate;
    const requestedSelection =
      requestedPlanHandle.length > 0 &&
      requestedPlanHandle.length <= 128 &&
      (planChange === "mismatch" || planChange === "unverified") &&
      requestedPlanHandle !== providerCurrentHandle &&
      requestedPlanHandle !== providerPendingHandle
        ? { shopifyPlanHandle: requestedPlanHandle }
        : null;
    return {
      merchantUi,
      commercial,
      currentContract,
      capacity,
      topUp,
      billingPeriodPhase: topUp?.billingPeriodPhase ?? null,
      lifecycleState,
      verificationState,
      scheduledCancellation,
      requestedSelection,
      usageHistoryAvailable,
      usageHistoryHref,
      purchaseHistoryAvailable,
    };
  } catch (error) {
    logBillingBoundaryFailure({ event: "shopify.billing.options_read_failed", operation: "read_billing_options", stage: "project_options", shopId: shop.id, error }, logger);
    const requestedPlanHandle =
      url.searchParams.get("requested_plan_handle")?.trim() ?? "";
    const planChange = url.searchParams.get("plan_change");
    return {
      merchantUi,
      commercial: null,
      currentContract,
      capacity: null,
      topUp: null,
      billingPeriodPhase: null,
      lifecycleState: "UNRESOLVED",
      verificationState: "VERIFICATION_UNAVAILABLE",
      scheduledCancellation: false,
      requestedSelection:
        requestedPlanHandle.length > 0 &&
        requestedPlanHandle.length <= 128 &&
        (planChange === "mismatch" || planChange === "unverified")
          ? { shopifyPlanHandle: requestedPlanHandle }
          : null,
      purchaseHistoryAvailable,
      usageHistoryAvailable,
      usageHistoryHref,
    };
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop } = merchant;
  assertActiveShop(shop, {
    route: "/app/billing/options",
    capability: "purchase-recovery-credits",
    redirectTo: "/app/merchant-support",
  });
  const subscription = await merchant.readSubscription();
  const merchantExperienceState = resolveMerchantExperienceState({
    shop,
    subscription,
  });
  if (!canAccessMerchantSurface(merchantExperienceState, "BILLING_OPTIONS"))
    throw new Response(null, {
      status: 302,
      headers: {
        Location: getMerchantDeniedRedirect(
          merchantExperienceState,
          "BILLING_OPTIONS",
        ),
      },
    });
  const formData = await request.formData();
  const purchase = await billingService.requestRecoveryCreditPack(
    shop.id,
    String(formData.get("intent") ?? ""),
    String(formData.get("purchaseId") ?? ""),
    String(formData.get("eventHandle") ?? ""),
  );
  return {
    purchase: {
      status: purchase.status,
      currentAmount: Number(purchase.currentAmount),
      usageReportState: purchase.usageEvent?.shopifyReportState ?? "UNKNOWN",
    },
  };
}

export default function BillingOptionsPage() {
  const data = useLoaderData<typeof loader>();
  const i18n = createMerchantI18n(data.merchantUi);
  const providerSubscription =
    data.commercial?.status === "ACTIVE_SUBSCRIPTION"
      ? data.commercial.subscription
      : null;
  const mapping =
    data.commercial?.status === "ACTIVE_SUBSCRIPTION"
      ? data.commercial.modaMapping
      : null;
  const mappingStatus =
    data.commercial?.status === "ACTIVE_SUBSCRIPTION"
      ? data.commercial.mappingStatus
      : null;
  const providerMappedCurrentContract =
    data.verificationState === "ACTIVE_SUBSCRIPTION" &&
    mappingStatus === "MAPPED";
  const topUpState = data.topUp
    ? {
        configured:
          providerMappedCurrentContract &&
          data.topUp.recoveryCreditOffers.length > 0,
        purchaseEligible:
          data.verificationState === "ACTIVE_SUBSCRIPTION" &&
          mappingStatus === "MAPPED" &&
          data.lifecycleState === "ACTIVE" &&
          data.topUp.purchaseEligible,
        offers: providerMappedCurrentContract
          ? data.topUp.recoveryCreditOffers
          : [],
        offerVerificationState: data.topUp.recoveryCreditOfferVerificationState,
        paidIncludedCreditsAvailable:
          data.capacity?.paidIncluded?.remaining ?? null,
        freeLifetime: data.capacity?.freeLifetime
          ? {
              granted: data.capacity.freeLifetime.granted,
              remaining: data.capacity.freeLifetime.remaining,
            }
          : null,
        promotionalCreditsAvailable: data.capacity?.promotional.remaining ?? 0,
        purchasedCreditsAvailable:
          data.capacity?.purchased.available ??
          data.topUp.purchasedRecoveryCredits.available,
        latestPurchase: data.topUp.latestPurchase,
        unresolvedPurchases: data.topUp.unresolvedPurchases,
      }
    : {
        configured: false,
        purchaseEligible: false,
        offers: [],
        offerVerificationState: data.verificationState === "VERIFICATION_UNAVAILABLE"
          ? "VERIFICATION_UNAVAILABLE"
          : "VERIFIED",
        freeLifetime: data.capacity?.freeLifetime
          ? {
              granted: data.capacity.freeLifetime.granted,
              remaining: data.capacity.freeLifetime.remaining,
            }
          : null,
        purchasedCreditsAvailable: data.capacity?.purchased.available ?? 0,
        latestPurchase: null,
        unresolvedPurchases: [],
      };
  const current = providerSubscription
    ? {
        shopifyPlanHandle: providerSubscription.planHandle,
        mappedModaPlanName: mapping?.name ?? null,
        price: providerSubscription.price,
        interval: providerSubscription.billingPeriod,
        currentPeriodEnd: providerSubscription.currentPeriodEnd,
        cancelAtEndOfCycle: providerSubscription.cancelAtEndOfCycle,
      }
    : data.verificationState === "VERIFICATION_UNAVAILABLE"
      ? data.currentContract
      : null;
  const pending = providerSubscription?.pendingUpdate
    ? {
        shopifyPlanHandle: providerSubscription.pendingUpdate.planHandle,
        price: providerSubscription.pendingUpdate.price,
        effectiveAt: providerSubscription.pendingUpdate.effectiveAt,
      }
    : null;
  const initialView = data.requestedSelection || data.lifecycleState === "POST_CONTRACT" || data.lifecycleState === "NO_ACTIVE_SUBSCRIPTION"
    ? "plans"
    : "topup";

  return (
    <s-page heading={i18n.t("billingCommerce.page.title")}>
      <div className="moda-page-shell moda-page-shell--standard">
        <Breadcrumbs
          items={[]}
          current={i18n.t("billingCommerce.page.title")}
          merchantUi={data.merchantUi}
        />
        {data.usageHistoryAvailable && (
          <div className="billing-options__history-action">
            <s-button href={data.usageHistoryHref} variant="secondary">
              {i18n.t("usageHistory.title")}
            </s-button>
          </div>
        )}
        <BillingPurchaseHub
          merchantUi={data.merchantUi}
          capacity={data.capacity}
          billingPeriodPhase={data.billingPeriodPhase}
          lifecycleState={data.lifecycleState}
          verificationState={data.verificationState}
          mappingStatus={mappingStatus}
          topUpState={topUpState}
          current={current}
          pending={pending}
          requestedSelection={data.requestedSelection}
          initialView={initialView}
          scheduledCancellation={data.scheduledCancellation}
          purchaseHistoryAvailable={data.purchaseHistoryAvailable}
          managePlansHref="/app/billing/select"
          managePlansAvailable={
            data.verificationState !== "VERIFICATION_UNAVAILABLE" &&
            data.lifecycleState !== "FROZEN"
          }
        />
      </div>
    </s-page>
  );
}
