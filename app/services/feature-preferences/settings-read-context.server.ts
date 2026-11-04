import type {
  Prisma,
  PrismaClient,
  Shop,
  ShopSettings,
  Subscription,
  ShopFeaturePreference,
} from "@prisma/client";
import db from "@/db.server";
import type { MerchantRequestContext } from "../shop/merchant-request-context.server";
import { recordMerchantSettingsFailure } from "./merchant-settings-observability.server";

export type SettingsPlan = Prisma.BillingPlanGetPayload<{
  include: { features: { include: { feature: true } } };
}>;
export type SettingsReadContext = Readonly<{
  shop: Pick<Shop, "id" | "status" | "defaultLanguageTag">;
  settings: ShopSettings | null;
  subscription: Subscription | null;
  plan: SettingsPlan | null;
  preferences: readonly ShopFeaturePreference[];
}>;
export async function loadSettingsReadContext(
  merchant: MerchantRequestContext,
  client: PrismaClient = db,
): Promise<SettingsReadContext> {
  // Scalar failures are diagnosed by the request-context owner.
  const [subscription, settings] = await Promise.all([
    merchant.readSubscription(),
    merchant.readSettings(),
  ]);
  let plan: SettingsPlan | null;
  let preferences: ShopFeaturePreference[];
  try {
    [plan, preferences] = await Promise.all([
      subscription?.planId
        ? client.billingPlan.findUnique({
            where: { id: subscription.planId },
            include: {
              features: {
                include: { feature: true },
                orderBy: [
                  { feature: { displayName: "asc" } },
                  { featureId: "asc" },
                ],
              },
            },
          })
        : null,
      client.shopFeaturePreference.findMany({
        where: { shopId: merchant.shop.id },
        orderBy: { featureId: "asc" },
      }),
    ]);
  } catch (error) {
    recordMerchantSettingsFailure(
      "read",
      "plan_features_preferences",
      merchant.shop.id,
      error,
    );
    throw error;
  }
  const { id, status, defaultLanguageTag } = merchant.shop;
  return {
    shop: { id, status, defaultLanguageTag },
    settings,
    subscription,
    plan,
    preferences,
  };
}
