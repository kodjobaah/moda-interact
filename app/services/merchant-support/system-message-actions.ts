import { BillingSystemMessageCodeSchema } from "@modainteract/moda-interact-shared/billing";

export const BILLING_ROUTE = "/app/billing";
export const BILLING_SELECT_ROUTE = "/app/billing/select";

export type MerchantSystemMessageAction = {
  href: string;
  labelKey: "billing.viewPlans" | "billing.upgradePlan";
};

export function getMerchantSystemMessageAction(
  systemCode: string | null | undefined,
): MerchantSystemMessageAction | null {
  const parsed = BillingSystemMessageCodeSchema.safeParse(systemCode);
  if (!parsed.success) return null;

  switch (parsed.data) {
    case "BILLING_FREE_ALLOWANCE_WARNING":
      return { href: BILLING_SELECT_ROUTE, labelKey: "billing.viewPlans" };
    case "BILLING_FREE_ALLOWANCE_EXHAUSTED":
      return { href: BILLING_SELECT_ROUTE, labelKey: "billing.upgradePlan" };
    case "BILLING_PLAN_UPGRADED":
    case "BILLING_PLAN_DOWNGRADE_SCHEDULED":
    case "BILLING_SUBSCRIPTION_ENDED":
    case "BILLING_SAFETY_LIMIT_REACHED":
      return { href: BILLING_ROUTE, labelKey: "billing.viewPlans" };
    default:
      return null;
  }
}
