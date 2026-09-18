import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import type { Prisma } from "@prisma/client";

import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "@/services/shop/merchant-route-access-policy";
import { billingService } from "@/services/billing/billing.service";

type FeatureViewModel = {
  key: string;
  displayName: string;
  description: string | null;
  activationMode: "ALWAYS_ENABLED" | "MERCHANT_OPT_IN";
  supportedByCurrentPlan: boolean;
  preferenceEnabled: boolean;
  effectiveEnabled: boolean;
};

async function resolveFeatureShop(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/features", capability: "manage-features", redirectTo: "/app/merchant-support" });
  return shop;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await resolveFeatureShop(request);
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  const subscription = await billingService.getSubscription(shop.id);
  const state = resolveMerchantExperienceState({ shop, settings, subscription });
  if (!canAccessMerchantSurface(state, "FEATURES")) {
    throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(state, "FEATURES") } });
  }

  const [currentSubscription, preferences] = await Promise.all([
    db.subscription.findUnique({
      where: { shopId: shop.id },
      include: { plan: { include: { features: { include: { feature: true } } } } },
    }),
    db.shopFeaturePreference.findMany({ where: { shopId: shop.id }, include: { feature: true } }),
  ]);
  const preferenceByFeatureId = new Map<string, { featureId: string; enabled: boolean }>(preferences.map((preference: { featureId: string; enabled: boolean }) => [preference.featureId, preference]));
  const featureRows = await db.feature.findMany({ where: { active: true }, orderBy: { displayName: "asc" } });
  const enabledPlanFeatures = new Map(
    (currentSubscription?.plan?.features ?? []).map((mapping: { featureId: string; enabled: boolean }) => [mapping.featureId, mapping.enabled]),
  );

  const features: FeatureViewModel[] = featureRows.map((feature: { id: string; key: string; displayName: string; description: string | null; active: boolean; activationMode: "ALWAYS_ENABLED" | "MERCHANT_OPT_IN" }) => {
    const supportedByCurrentPlan = enabledPlanFeatures.get(feature.id) === true;
    const preferenceEnabled = preferenceByFeatureId.get(feature.id)?.enabled === true;
    return {
      key: feature.key,
      displayName: feature.displayName,
      description: feature.description,
      activationMode: feature.activationMode,
      supportedByCurrentPlan,
      preferenceEnabled,
      effectiveEnabled: feature.active && supportedByCurrentPlan && (
        feature.activationMode === "ALWAYS_ENABLED" || preferenceEnabled
      ),
    };
  });

  return { features };
}

export async function action({ request }: ActionFunctionArgs) {
  const shop = await resolveFeatureShop(request);
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });
  const subscription = await billingService.getSubscription(shop.id);
  const state = resolveMerchantExperienceState({ shop, settings, subscription });
  if (!canAccessMerchantSurface(state, "FEATURES")) {
    throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(state, "FEATURES") } });
  }

  const formData = await request.formData();
  if (formData.get("intent") !== "set-feature-preference") {
    throw new Response("Unsupported intent", { status: 400 });
  }
  const featureKey = String(formData.get("featureKey") ?? "");
  const value = formData.get("value");
  if (!featureKey || (value !== "true" && value !== "false")) {
    throw new Response("Invalid feature preference", { status: 400 });
  }

  await db.$transaction(async (transaction: Prisma.TransactionClient) => {
    const feature = await transaction.feature.findUnique({ where: { key: featureKey } });
    if (!feature?.active || feature.activationMode !== "MERCHANT_OPT_IN") {
      throw new Response("Feature preference is unavailable", { status: 400 });
    }
    const currentSubscription = await transaction.subscription.findUnique({
      where: { shopId: shop.id },
      select: { planId: true },
    });
    if (!currentSubscription?.planId) throw new Response("Feature preference is unavailable", { status: 400 });
    const mapping = await transaction.billingPlanFeature.findUnique({
      where: { planId_featureId: { planId: currentSubscription.planId, featureId: feature.id } },
    });
    if (!mapping?.enabled) throw new Response("Feature preference is unavailable", { status: 400 });
    await transaction.shopFeaturePreference.upsert({
      where: { shopId_featureId: { shopId: shop.id, featureId: feature.id } },
      update: { enabled: value === "true" },
      create: { shopId: shop.id, featureId: feature.id, enabled: value === "true" },
    });
  });

  return { ok: true };
}

export default function FeaturesRoute() {
  const { features } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1>Features</h1>
      {actionData?.ok ? <p role="status">Feature preference saved.</p> : null}
      {features.map((feature) => (
        <article key={feature.key}>
          <h2>{feature.displayName}</h2>
          {feature.description ? <p>{feature.description}</p> : null}
          {feature.activationMode === "ALWAYS_ENABLED" ? (
            <p>{feature.effectiveEnabled ? "Enabled" : "Unavailable"} {feature.supportedByCurrentPlan ? "Included with this plan" : "Unavailable on this plan"}</p>
          ) : feature.supportedByCurrentPlan ? (
            <Form method="post">
              <input type="hidden" name="intent" value="set-feature-preference" />
              <input type="hidden" name="featureKey" value={feature.key} />
              <input type="hidden" name="value" value={feature.preferenceEnabled ? "false" : "true"} />
              <button type="submit" aria-pressed={feature.effectiveEnabled}>
                {feature.effectiveEnabled ? "Disable" : "Enable"}
              </button>
            </Form>
          ) : <p>Unavailable on this plan</p>}
        </article>
      ))}
    </main>
  );
}