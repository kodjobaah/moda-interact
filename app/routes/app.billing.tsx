import type { ActionFunctionArgs, HeadersArgs, LoaderFunctionArgs } from "react-router";
import { Link, redirect, useFetcher, useLoaderData, useRouteError } from "react-router";
import { randomUUID } from "node:crypto";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

import { billingService } from "../services/billing/billing.service";

import { shopService } from "../services/shop/shop.service";
import { merchantUiContext, createMerchantI18n } from "../utils/merchant-i18n";
import db from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });

  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  const state = await billingService.getMerchantBillingState(shop.id);

  if (!state.subscription || state.subscription.status === "NO_CONTRACT") {
    throw redirect("/app/billing/select");
  }

  return {
    merchantUi: merchantUiContext(settings, session),
    subscription: {
      status: state.subscription.status,
      planKind: state.subscription.plan?.kind ?? null,
      planName: state.subscription.plan?.name ?? state.subscription.observedShopifyPlanHandle,
      currentPeriodStart: state.subscription.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: state.subscription.currentPeriodEnd?.toISOString() ?? null,
      trialEndsAt: state.subscription.trialEndsAt?.toISOString() ?? null,
      cancelAtPeriodEnd: state.subscription.cancelAtPeriodEnd,
      pendingPlanName: state.subscription.pendingPlan?.name ?? state.subscription.pendingShopifyPlanHandle,
      pendingEffectiveAt: state.subscription.pendingEffectiveAt?.toISOString() ?? null,
    },
    allowance: state.allowance,
    remaining: state.remaining,
    usageQuantity: state.usageQuantity,
    purchasedRecoveryCredits: state.purchasedRecoveryCredits,
    recoveryCreditPackEnabled: state.recoveryCreditPackEnabled,
    recoveryCreditsPerPack: state.recoveryCreditsPerPack,
    recoveryCreditPackMeter: state.recoveryCreditPackMeter,
    recoveryCreditPackMeterVerified: state.recoveryCreditPackMeterVerified,
    purchaseId: randomUUID(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({
    admin,
    domain: session.shop,
  });
  const formData = await request.formData();
  const purchase = await billingService.requestRecoveryCreditPack(
    shop.id,
    String(formData.get("intent") ?? ""),
    String(formData.get("purchaseId") ?? ""),
  );
  return { purchasePending: purchase.status === "PENDING_BILLING" };
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
    purchaseId,
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
          <p>{i18n.t("billing.currentPlan")}: <strong>{subscription.planName ?? i18n.t("billing.unknownPlan")}</strong></p>
          <p>{i18n.t("billing.status")}: <strong>{subscription.status}</strong></p>

          {isFree && allowance !== null ? (
            <p>{i18n.t("billing.freeAllowance", { remaining, allowance })}</p>
          ) : (
            <p>{i18n.t("billing.paidUsage", { quantity: usageQuantity })}</p>
          )}

          {subscription.currentPeriodStart && subscription.currentPeriodEnd ? (
            <p>{i18n.t("billing.currentPeriod", {
              start: i18n.formatDate(subscription.currentPeriodStart),
              end: i18n.formatDate(subscription.currentPeriodEnd),
            })}</p>
          ) : null}
          {subscription.trialEndsAt ? <p>{i18n.t("billing.trialEnds", { date: i18n.formatDate(subscription.trialEndsAt) })}</p> : null}
          {subscription.cancelAtPeriodEnd ? <p>{i18n.t("billing.cancelAtPeriodEnd")}</p> : null}

          {subscription.pendingPlanName && subscription.pendingEffectiveAt ? (
            <p>{i18n.t("billing.pendingChange", {
              plan: subscription.pendingPlanName,
              date: i18n.formatDate(subscription.pendingEffectiveAt),
            })}</p>
          ) : null}

          <section>
            <p>{i18n.t("billing.purchasedRecoveryCredits", {
              granted: purchasedRecoveryCredits.grantedQuantity,
              committed: purchasedRecoveryCredits.committedQuantity,
              reserved: purchasedRecoveryCredits.reservedQuantity,
              available: purchasedRecoveryCredits.available,
            })}</p>
            {recoveryCreditPackEnabled && recoveryCreditsPerPack !== null && recoveryCreditsPerPack > 0 && recoveryCreditPackMeter && recoveryCreditPackMeterVerified ? (
              <>
              <p>{i18n.t("billing.recoveryCreditPackDescription", { quantity: recoveryCreditsPerPack })}</p>
              <p>{i18n.t("billing.recoveryCreditPackShopifyMeter")}</p>
              {fetcher.data?.purchasePending ? (
                <p>{i18n.t("billing.recoveryCreditPurchasePending")}</p>
              ) : (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="BUY_RECOVERY_CREDIT_PACK" />
                  <input type="hidden" name="purchaseId" value={purchaseId} />
                  <button type="submit" disabled={fetcher.state !== "idle"}>
                    {i18n.t(fetcher.state === "idle" ? "billing.buyRecoveryCreditPack" : "billing.recoveryCreditPurchasePending")}
                  </button>
                </fetcher.Form>
              )}
              </>
            ) : null}
          </section>
        </>
      )}

      <Link to="/app/billing/select">{i18n.t(isFree ? "billing.viewPlans" : "billing.changePlan")}</Link>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: HeadersArgs) => {
  return boundary.headers(headersArgs);
};
