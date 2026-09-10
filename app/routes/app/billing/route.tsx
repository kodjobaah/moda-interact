import type {
  ActionFunctionArgs,
  HeadersArgs,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useFetcher, useLoaderData, useRouteError } from "react-router";
import { randomUUID } from "node:crypto";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "@/shopify.server";

import { billingService } from "@/services/billing/billing.service";

import { shopService } from "@/services/shop/shop.service";
import { merchantUiContext, createMerchantI18n } from "@/utils/merchant-i18n";
import db from "@/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const {
    admin,
    session,
    redirect: shopifyRedirect,
  } = await authenticate.admin(request);

  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });

  const settings = await db.shopSettings.findUnique({
    where: { shopId: shop.id },
  });
  const state = await billingService.getMerchantBillingState(shop.id);

  if (!state.subscription || state.subscription.status === "NO_CONTRACT") {
    return shopifyRedirect("/app/billing/select");
  }

  return {
    merchantUi: merchantUiContext(settings, session),
    subscription: {
      status: state.subscription.status,
      planKind: state.subscription.plan?.kind ?? null,
      planName:
        state.subscription.plan?.name ??
        state.subscription.observedShopifyPlanHandle,
      currentPeriodStart:
        state.subscription.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd:
        state.subscription.currentPeriodEnd?.toISOString() ?? null,
      trialEndsAt: state.subscription.trialEndsAt?.toISOString() ?? null,
      cancelAtPeriodEnd: state.subscription.cancelAtPeriodEnd,
      pendingPlanName:
        state.subscription.pendingPlan?.name ??
        state.subscription.pendingShopifyPlanHandle,
      pendingEffectiveAt:
        state.subscription.pendingEffectiveAt?.toISOString() ?? null,
    },
    allowance: state.allowance,
    remaining: state.remaining,
    usageQuantity: state.usageQuantity,
    purchasedRecoveryCredits: state.purchasedRecoveryCredits,
    recoveryCreditPackEnabled: state.recoveryCreditPackEnabled,
    recoveryCreditsPerPack: state.recoveryCreditsPerPack,
    recoveryCreditPackMeter: state.recoveryCreditPackMeter,
    recoveryCreditPackMeterVerified: state.recoveryCreditPackMeterVerified,
    recoveryCreditPackPurchaseEligible:
      state.recoveryCreditPackPurchaseEligible,
    purchaseId: randomUUID(),
    cancellationRequest: state.cancellationRequest
      ? {
          status: state.cancellationRequest.status,
          mode: state.cancellationRequest.mode,
          currentPeriodEnd:
            state.cancellationRequest.currentPeriodEndSnapshot?.toISOString() ?? null,
        }
      : null,
    recoveryCreditPurchases: (state.recoveryCreditPurchases ?? []).map((purchase) => ({
      id: purchase.id,
      creditsGranted: purchase.creditsGranted,
      createdAt: purchase.createdAt.toISOString(),
      refundStatus: purchase.refund?.status ?? null,
    })),
    cancellationRequestId: randomUUID(),
    refundRequestId: randomUUID(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent === "BUY_RECOVERY_CREDIT_PACK") {
    const purchase = await billingService.requestRecoveryCreditPack(
      shop.id,
      intent,
      String(formData.get("purchaseId") ?? ""),
    );
    return { purchasePending: purchase.status === "PENDING_BILLING" };
  }
  if (intent === "REQUEST_SUBSCRIPTION_CANCELLATION") {
    await billingService.requestSubscriptionCancellation(
      shop.id,
      intent,
      String(formData.get("requestId") ?? ""),
    );
    return { cancellationRequested: true };
  }
  if (intent === "REQUEST_RECOVERY_CREDIT_REFUND") {
    await billingService.requestRecoveryCreditRefund(
      shop.id,
      intent,
      String(formData.get("refundRequestId") ?? ""),
      String(formData.get("purchaseId") ?? ""),
    );
    return { refundRequested: true };
  }
  throw new Error("Unsupported billing action.");
}

export default function BillingRoute() {
  const {
    merchantUi,
    subscription,
    allowance,
    remaining,
    usageQuantity,
    purchasedRecoveryCredits,
    recoveryCreditPackEnabled,
    recoveryCreditsPerPack,
    recoveryCreditPackMeter,
    recoveryCreditPackMeterVerified,
    recoveryCreditPackPurchaseEligible,
    purchaseId,
    cancellationRequest,
    recoveryCreditPurchases,
    cancellationRequestId,
    refundRequestId,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const i18n = createMerchantI18n(merchantUi);
  const isFree = subscription.planKind === "FREE";
  const isSafeProjection = ["ACTIVE", "TRIALING"].includes(subscription.status);

  return (
    <div
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: 24,
      }}
    >
      <h1>{i18n.t("billing.title")}</h1>

      {!isSafeProjection ? (
        <section>
          <h2>{i18n.t("billing.configurationUnavailable")}</h2>
          <p>{i18n.t("billing.configurationUnavailableDescription")}</p>
        </section>
      ) : (
        <>
          <p>
            {i18n.t("billing.currentPlan")}:{" "}
            <strong>
              {subscription.planName ?? i18n.t("billing.unknownPlan")}
            </strong>
          </p>
          <p>
            {i18n.t("billing.status")}: <strong>{subscription.status}</strong>
          </p>

          {isFree && allowance !== null ? (
            <p>{i18n.t("billing.freeAllowance", { remaining, allowance })}</p>
          ) : (
            <p>{i18n.t("billing.paidUsage", { quantity: usageQuantity })}</p>
          )}

          {subscription.currentPeriodStart && subscription.currentPeriodEnd ? (
            <p>
              {i18n.t("billing.currentPeriod", {
                start: i18n.formatDate(subscription.currentPeriodStart),
                end: i18n.formatDate(subscription.currentPeriodEnd),
              })}
            </p>
          ) : null}
          {subscription.trialEndsAt ? (
            <p>
              {i18n.t("billing.trialEnds", {
                date: i18n.formatDate(subscription.trialEndsAt),
              })}
            </p>
          ) : null}
          {subscription.cancelAtPeriodEnd ? (
            <p>{i18n.t("billing.cancelAtPeriodEnd")}</p>
          ) : null}

          {subscription.pendingPlanName && subscription.pendingEffectiveAt ? (
            <p>
              {i18n.t("billing.pendingChange", {
                plan: subscription.pendingPlanName,
                date: i18n.formatDate(subscription.pendingEffectiveAt),
              })}
            </p>
          ) : null}

          <section>
            <h2>{i18n.t("billing.planActions")}</h2>
            <p>{i18n.t("billing.planActionsDescription")}</p>
            <Link to="/app/billing/select">
              {i18n.t(isFree ? "billing.viewPlans" : "billing.changePlan")}
            </Link>
            {isFree ? null : cancellationRequest?.status === "REQUESTED" ? (
              <p>{i18n.t("billing.cancellationRequested")}</p>
            ) : (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="REQUEST_SUBSCRIPTION_CANCELLATION" />
                <input type="hidden" name="requestId" value={cancellationRequestId} />
                <button type="submit" disabled={fetcher.state !== "idle"}>
                  {i18n.t("billing.requestCancellation")}
                </button>
              </fetcher.Form>
            )}
          </section>

          <section>
            <p>
              {i18n.t("billing.purchasedRecoveryCredits", {
                granted: purchasedRecoveryCredits.grantedQuantity,
                committed: purchasedRecoveryCredits.committedQuantity,
                reserved: purchasedRecoveryCredits.reservedQuantity,
                available: purchasedRecoveryCredits.available,
              })}
            </p>
            {recoveryCreditPackPurchaseEligible &&
            recoveryCreditPackEnabled &&
            recoveryCreditsPerPack !== null &&
            recoveryCreditsPerPack > 0 &&
            recoveryCreditPackMeter &&
            recoveryCreditPackMeterVerified ? (
              <>
                <p>
                  {i18n.t("billing.recoveryCreditPackDescription", {
                    quantity: recoveryCreditsPerPack,
                  })}
                </p>
                <p>{i18n.t("billing.recoveryCreditPackShopifyMeter")}</p>
                {fetcher.data?.purchasePending ? (
                  <p>{i18n.t("billing.recoveryCreditPurchasePending")}</p>
                ) : (
                  <fetcher.Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="BUY_RECOVERY_CREDIT_PACK"
                    />
                    <input type="hidden" name="purchaseId" value={purchaseId} />
                    <button type="submit" disabled={fetcher.state !== "idle"}>
                      {i18n.t(
                        fetcher.state === "idle"
                          ? "billing.buyRecoveryCreditPack"
                          : "billing.recoveryCreditPurchasePending",
                      )}
                    </button>
                  </fetcher.Form>
                )}
              </>
            ) : null}
            {recoveryCreditPurchases.length > 0 ? (
              <div>
                <h2>{i18n.t("billing.refundTitle")}</h2>
                <p>{i18n.t("billing.fullPackRefundOnly")}</p>
                {recoveryCreditPurchases.map((purchase) => (
                  <div key={purchase.id}>
                    <span>{i18n.t("billing.recoveryCreditPackQuantity", { quantity: purchase.creditsGranted })}</span>
                    {purchase.refundStatus ? (
                      <span>{i18n.t("billing.refundRequested")}</span>
                    ) : (
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="REQUEST_RECOVERY_CREDIT_REFUND" />
                        <input type="hidden" name="refundRequestId" value={refundRequestId} />
                        <input type="hidden" name="purchaseId" value={purchase.id} />
                        <button type="submit" disabled={fetcher.state !== "idle"}>
                          {i18n.t("billing.requestRefund")}
                        </button>
                      </fetcher.Form>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </>
      )}

      <Link to="/app/billing/select">
        {i18n.t(isFree ? "billing.viewPlans" : "billing.changePlan")}
      </Link>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: HeadersArgs) => {
  return boundary.headers(headersArgs);
};
