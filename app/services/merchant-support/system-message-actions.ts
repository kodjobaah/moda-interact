import { BillingSystemMessageCodeSchema } from "@modainteract/moda-interact-shared/billing";
import type { MerchantExperienceState } from "@/services/shop/merchant-route-access-policy";
import { canAccessMerchantSurface } from "@/services/shop/merchant-route-access-policy";

export const BILLING_SELECT_ROUTE = "/app/billing/select";
export const BILLING_OPTIONS_ROUTE = "/app/billing/options";

export type MerchantSystemMessageAction = {
  href: string;
  labelKey: "billing.viewPlans" | "billing.upgradePlan";
};

export function getMerchantSystemMessageAction(
  systemCode: string | null | undefined,
  state: MerchantExperienceState,
): MerchantSystemMessageAction | null {
  const parsed = BillingSystemMessageCodeSchema.safeParse(systemCode);
  if (!parsed.success) return null;

  switch (parsed.data) {
    case "BILLING_FREE_ALLOWANCE_WARNING":
      return canAccessMerchantSurface(state, "PLAN_SELECT") ? { href: BILLING_SELECT_ROUTE, labelKey: "billing.viewPlans" } : null;
    case "BILLING_PLAN_UPGRADED":
    case "BILLING_PLAN_DOWNGRADE_SCHEDULED":
    case "BILLING_SUBSCRIPTION_ENDED":
    case "BILLING_SAFETY_LIMIT_REACHED":
      return canAccessMerchantSurface(state, "BILLING_OPTIONS") ? { href: BILLING_OPTIONS_ROUTE, labelKey: "billing.viewPlans" } : null;
    default:
      return null;
  }
}
