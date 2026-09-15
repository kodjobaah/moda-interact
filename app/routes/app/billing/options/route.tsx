import BillingPurchaseHub from "@/components/dashboard/BillingPurchaseHub";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";
import { billingService } from "@/services/billing/billing.service";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { canAccessMerchantSurface, getMerchantDeniedRedirect, resolveMerchantExperienceState } from "@/services/shop/merchant-route-access-policy";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/options", capability: "manage-billing", redirectTo: "/app/merchant-support" });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  const subscription = await billingService.getSubscription(shop.id);
  const merchantExperienceState = resolveMerchantExperienceState({ shop, settings, subscription });
  if (!canAccessMerchantSurface(merchantExperienceState, "BILLING_OPTIONS")) throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(merchantExperienceState, "BILLING_OPTIONS") } });
  const purchaseHistoryAvailable = canAccessMerchantSurface(merchantExperienceState, "BILLING_PURCHASE_HISTORY");
  const merchantUi = merchantUiContext(settings, session);

  try {
    const [commercialResult, capacityResult, lifecycleResult, topUpResult] =
      await Promise.allSettled([
      billingService.getMerchantShopifySubscriptionState(shop.id),
      billingService.getMerchantRecoveryCapacityState(shop.id),
      billingService.getMerchantShopifyLifecycleState(shop.id),
      billingService.getMerchantBillingState(shop.id),
      ]);
    const commercial = commercialResult.status === "fulfilled" ? commercialResult.value : null;
    const capacity = capacityResult.status === "fulfilled" ? capacityResult.value : null;
    const lifecycle = lifecycleResult.status === "fulfilled" ? lifecycleResult.value : null;
    const topUp = topUpResult.status === "fulfilled" ? topUpResult.value : null;
    const lifecycleState = lifecycle?.state === "FROZEN" ? "FROZEN" : lifecycle?.state ?? "UNRESOLVED";
    const verificationState = lifecycleState === "FROZEN"
      ? "FROZEN"
      : commercial?.status ?? "VERIFICATION_UNAVAILABLE";
    const requestedPlanHandle = url.searchParams.get("requested_plan_handle")?.trim() ?? "";
    const planChange = url.searchParams.get("plan_change");
    const providerCurrentHandle = commercial?.subscription?.planHandle ?? null;
    const providerPendingHandle = commercial?.subscription?.pendingUpdate?.planHandle ?? null;
    const scheduledCancellation = commercial?.status === "ACTIVE_SUBSCRIPTION" &&
      commercial.subscription.cancelAtEndOfCycle &&
      !commercial.subscription.pendingUpdate;
    const requestedSelection = requestedPlanHandle.length > 0
      && requestedPlanHandle.length <= 128
      && (planChange === "mismatch" || planChange === "unverified")
      && requestedPlanHandle !== providerCurrentHandle
      && requestedPlanHandle !== providerPendingHandle
      ? { shopifyPlanHandle: requestedPlanHandle }
      : null;
    return {
      merchantUi,
      commercial,
      capacity,
      topUp,
      billingPeriodPhase: topUp?.billingPeriodPhase ?? null,
      lifecycleState,
      verificationState,
      scheduledCancellation,
      requestedSelection,
      purchaseHistoryAvailable,
    };
  } catch {
    const requestedPlanHandle = url.searchParams.get("requested_plan_handle")?.trim() ?? "";
    const planChange = url.searchParams.get("plan_change");
    return { merchantUi, commercial: null, capacity: null, topUp: null, billingPeriodPhase: null, lifecycleState: "UNRESOLVED", verificationState: "VERIFICATION_UNAVAILABLE", scheduledCancellation: false, requestedSelection: requestedPlanHandle.length > 0 && requestedPlanHandle.length <= 128 && (planChange === "mismatch" || planChange === "unverified") ? { shopifyPlanHandle: requestedPlanHandle } : null, purchaseHistoryAvailable };
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/billing/options", capability: "purchase-recovery-credits", redirectTo: "/app/merchant-support" });
  const [settings, subscription] = await Promise.all([
    db.shopSettings.findUnique({ where: { shopId: shop.id } }),
    billingService.getSubscription(shop.id),
  ]);
  const merchantExperienceState = resolveMerchantExperienceState({ shop, settings, subscription });
  if (!canAccessMerchantSurface(merchantExperienceState, "BILLING_OPTIONS")) throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(merchantExperienceState, "BILLING_OPTIONS") } });
  const [capacity, lifecycle, commercial] = await Promise.all([
    billingService.getMerchantRecoveryCapacityState(shop.id),
    billingService.getMerchantShopifyLifecycleState(shop.id),
    billingService.getMerchantShopifySubscriptionState(shop.id),
  ]);
  const scheduledCancellation = commercial.status === "ACTIVE_SUBSCRIPTION" &&
    commercial.subscription.cancelAtEndOfCycle &&
    !commercial.subscription.pendingUpdate;
  if (
    capacity.availability === "CONTRACT_FROZEN" ||
    capacity.availability === "CONTRACT_REQUIRED" ||
    lifecycle.state === "FROZEN" ||
    scheduledCancellation
  ) {
    throw new Error("Recovery credit packs are unavailable while Shopify billing is restricted.");
  }
  const formData = await request.formData();
  const purchase = await billingService.requestRecoveryCreditPack(shop.id, String(formData.get("intent") ?? ""), String(formData.get("purchaseId") ?? ""));
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
  const subscription = data.commercial?.status === "ACTIVE_SUBSCRIPTION" ? data.commercial.subscription : null;
  const mapping = data.commercial?.status === "ACTIVE_SUBSCRIPTION" ? data.commercial.modaMapping : null;
  const mappingStatus = data.commercial?.status === "ACTIVE_SUBSCRIPTION" ? data.commercial.mappingStatus : null;
  const hasMappedCurrentContract = data.verificationState === "ACTIVE_SUBSCRIPTION"
    && mappingStatus === "MAPPED";
  const topUpState = data.topUp ? {
    configured: hasMappedCurrentContract && data.topUp.recoveryCreditOffers.length > 0,
    purchaseEligible: data.verificationState === "ACTIVE_SUBSCRIPTION" && mappingStatus === "MAPPED" && data.lifecycleState === "ACTIVE" && !data.scheduledCancellation && data.topUp.purchaseEligible,
    offers: hasMappedCurrentContract ? data.topUp.recoveryCreditOffers : [],
    offerVerificationState: data.topUp.recoveryCreditOfferVerificationState,
    paidIncludedCreditsAvailable: data.capacity?.paidIncluded?.remaining ?? null,
    freeLifetimeCreditsAvailable: data.capacity?.freeLifetime?.remaining ?? null,
    promotionalCreditsAvailable: data.capacity?.promotional.remaining ?? 0,
    purchasedCreditsAvailable: data.capacity?.purchased.available ?? data.topUp.purchasedRecoveryCredits.available,
    latestPurchase: data.topUp.latestPurchase,
  } : { configured: false, purchaseEligible: false, offers: [], offerVerificationState: "VERIFICATION_UNAVAILABLE", purchasedCreditsAvailable: 0, latestPurchase: null };
  const current = subscription ? { shopifyPlanHandle: subscription.planHandle, mappedModaPlanName: mapping?.name ?? null, price: subscription.price, interval: subscription.billingPeriod, currentPeriodEnd: subscription.currentPeriodEnd, cancelAtEndOfCycle: subscription.cancelAtEndOfCycle } : null;
  const pending = subscription?.pendingUpdate ? { shopifyPlanHandle: subscription.pendingUpdate.planHandle, price: subscription.pendingUpdate.price, effectiveAt: subscription.pendingUpdate.effectiveAt } : null;
  const initialView = data.requestedSelection ? "plans" : "topup";

  return (
    <s-page heading={i18n.t("billingCommerce.page.title")}>
      <Breadcrumbs items={[]} current={i18n.t("billingCommerce.page.title")} merchantUi={data.merchantUi} />
      <BillingPurchaseHub merchantUi={data.merchantUi} capacity={data.capacity} billingPeriodPhase={data.billingPeriodPhase} lifecycleState={data.lifecycleState} verificationState={data.verificationState} mappingStatus={mappingStatus} topUpState={topUpState} current={current} pending={pending} requestedSelection={data.requestedSelection} initialView={initialView} scheduledCancellation={data.scheduledCancellation} purchaseHistoryAvailable={data.purchaseHistoryAvailable} managePlansHref="/app/billing/select" managePlansAvailable={data.verificationState !== "VERIFICATION_UNAVAILABLE" && data.lifecycleState !== "FROZEN"} />
    </s-page>
  );
}
