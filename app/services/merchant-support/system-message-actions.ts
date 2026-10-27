import { BillingSystemMessageCodeSchema } from "@modainteract/moda-interact-shared/billing";
import type { MerchantExperienceState } from "@/services/shop/merchant-route-access-policy";
import { canAccessMerchantSurface } from "@/services/shop/merchant-route-access-policy";

export const BILLING_SELECT_ROUTE = "/app/billing/select";
export const BILLING_OPTIONS_ROUTE = "/app/billing/options";

export type MerchantSystemMessageAction = {
  href: string;
  labelKey: "billing.viewPlans" | "billing.upgradePlan" | "billing.subscribeAgain";
};

export type RecoverySupportMessageAction = {
  href: string;
  labelKey: "support.viewRecoveryConversation";
};

const RECOVERY_INITIAL_OUTREACH_SENT = "RECOVERY_INITIAL_OUTREACH_SENT";

function isSafeRecoveryActionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 191
    && !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return character === "/" || character === "\\"
        || codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
}

export function getRecoverySupportMessageAction(input: {
  systemCode: string | null | undefined;
  systemVersion: string | null | undefined;
  checkoutRecoveryId: string | null | undefined;
  merchantExperienceState: MerchantExperienceState;
}): RecoverySupportMessageAction | null {
  if (input.systemCode !== RECOVERY_INITIAL_OUTREACH_SENT || input.systemVersion !== "1") return null;
  if (!isSafeRecoveryActionId(input.checkoutRecoveryId)) return null;
  if (!canAccessMerchantSurface(input.merchantExperienceState, "RECOVERY_HISTORY")) return null;
  return {
    href: `/app/recoveries/${encodeURIComponent(input.checkoutRecoveryId)}#recovery-conversation`,
    labelKey: "support.viewRecoveryConversation",
  };
}

export function getMerchantSystemMessageAction(
  systemCode: string | null | undefined,
  state: MerchantExperienceState,
): MerchantSystemMessageAction | null {
  const parsed = BillingSystemMessageCodeSchema.safeParse(systemCode);
  if (!parsed.success) return null;

  switch (parsed.data) {
    case "BILLING_FREE_ALLOWANCE_WARNING":
      return canAccessMerchantSurface(state, "PLAN_SELECT") ? { href: BILLING_SELECT_ROUTE, labelKey: "billing.viewPlans" } : null;
    case "BILLING_SUBSCRIPTION_ENDED":
      return canAccessMerchantSurface(state, "BILLING_OPTIONS")
        ? {
            href: BILLING_OPTIONS_ROUTE,
            labelKey: state === "POST_CONTRACT" ? "billing.subscribeAgain" : "billing.viewPlans",
          }
        : null;
    case "BILLING_PLAN_UPGRADED":
    case "BILLING_PLAN_DOWNGRADE_SCHEDULED":
    case "BILLING_SAFETY_LIMIT_REACHED":
      return canAccessMerchantSurface(state, "BILLING_OPTIONS") ? { href: BILLING_OPTIONS_ROUTE, labelKey: "billing.viewPlans" } : null;
    default:
      return null;
  }
}
