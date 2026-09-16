import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { billingService } from "@/services/billing/billing.service";
import { canAccessMerchantSurface, getMerchantDeniedRedirect, resolveMerchantExperienceState } from "@/services/shop/merchant-route-access-policy";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import { loadRecoveryPolicySnapshot, RecoveryPolicyValidationError, saveMerchantRecoveryPolicy } from "@/services/recovery-policy/recovery-policy.server";

type DiscountRow = Awaited<ReturnType<typeof loader>>["discounts"][number];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/recovery-settings", capability: "read-recovery-settings", redirectTo: "/app/merchant-support" });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  const state = resolveMerchantExperienceState({ shop, settings, subscription: await billingService.getSubscription(shop.id) });
  if (!canAccessMerchantSurface(state, "RECOVERY_SETTINGS")) throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(state, "RECOVERY_SETTINGS") } });
  return { ...(await loadRecoveryPolicySnapshot(shop.id)), merchantUi: merchantUiContext(settings, session) };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/recovery-settings", capability: "write-recovery-settings", redirectTo: "/app/merchant-support" });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  const state = resolveMerchantExperienceState({ shop, settings, subscription: await billingService.getSubscription(shop.id) });
  if (!canAccessMerchantSurface(state, "RECOVERY_SETTINGS")) throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(state, "RECOVERY_SETTINGS") } });
  const form = await request.formData();
  try {
    await saveMerchantRecoveryPolicy(shop.id, {
      recoveryDelayMinutes: form.get("recoveryDelayMinutes"),
      recoveryOfferMode: form.get("recoveryOfferMode"),
      fixedShopifyDiscountId: form.get("recoveryOfferMode") === "FIXED" ? form.get("fixedShopifyDiscountId") : null,
      followUpEnabled: form.get("followUpEnabled"),
      followUpDelayMinutes: form.get("followUpDelayMinutes"),
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof RecoveryPolicyValidationError || error instanceof Error) return { ok: false, error: error.message };
    throw error;
  }
}

export default function RecoverySettingsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const i18n = createMerchantI18n(data.merchantUi);
  const effective = data.effective;
  return <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
    <h1>{i18n.t("recoverySettings.title")}</h1>
    {data.override ? <p role="status">{i18n.t("recoverySettings.adminOverride")}</p> : null}
    {actionData?.ok ? <p role="status">{i18n.t("recoverySettings.saved")}</p> : null}
    {actionData?.ok === false ? <p role="alert">{i18n.t("recoverySettings.invalid")}</p> : null}
    <Form method="post">
      <section><h2>{i18n.t("recoverySettings.start.title")}</h2><label>{i18n.t("recoverySettings.start.label")} <input type="number" name="recoveryDelayMinutes" min="0" max="10080" defaultValue={data.merchant.recoveryDelayMinutes} /></label><p>{i18n.t("recoverySettings.effective", { value: effective.recoveryDelayMinutes })}</p></section>
      <section><h2>{i18n.t("recoverySettings.offer.title")}</h2>
        {(["NONE", "FIXED", "AI_BEST_APPLICABLE"] as const).map((mode) => <label key={mode} style={{ display: "block" }}><input type="radio" name="recoveryOfferMode" value={mode} defaultChecked={data.merchant.recoveryOfferMode === mode} />{i18n.t(`recoverySettings.offer.${mode}`)}</label>)}
        <p>{i18n.t("recoverySettings.aiDescription")}</p>
        <p>{i18n.t("recoverySettings.effectiveOffer", { value: i18n.t(`recoverySettings.offer.${effective.recoveryOfferMode}`) })}</p>
        {data.catalogue?.status === "CURRENT" ? data.discounts.map((discount: DiscountRow) => <label key={discount.id} style={{ display: "block", opacity: discount.fixedSelectable ? 1 : 0.6 }}><input type="radio" name="fixedShopifyDiscountId" value={discount.id} defaultChecked={data.merchant.fixedShopifyDiscountId === discount.id} disabled={!discount.fixedSelectable} />{discount.title} ({discount.method}){discount.singleRedeemCode ? ` - ${discount.singleRedeemCode}` : ""}{!discount.fixedSelectable ? ` - ${i18n.t("recoverySettings.offer.notSelectable")}` : ""}</label>) : <p>{i18n.t("recoverySettings.offer.catalogueUnavailable")}</p>}
      </section>
      <section><h2>{i18n.t("recoverySettings.followUp.title")}</h2><label><input type="checkbox" name="followUpEnabled" defaultChecked={data.merchant.followUpEnabled} />{i18n.t("recoverySettings.followUp.enable")}</label><label>{i18n.t("recoverySettings.followUp.delay")} <input type="number" name="followUpDelayMinutes" min="1" max="10080" defaultValue={data.merchant.followUpDelayMinutes ?? ""} /></label><p>{i18n.t("recoverySettings.effectiveFollowUp", { value: effective.followUpEnabled ? `${effective.followUpDelayMinutes} minutes` : "disabled" })}</p><p>{i18n.t("recoverySettings.followUp.creditWarning")}</p></section>
      <button type="submit">{i18n.t("recoverySettings.save")}</button>
    </Form>
  </main>;
}