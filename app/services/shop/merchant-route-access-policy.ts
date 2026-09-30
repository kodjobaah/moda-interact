export const MERCHANT_EXPERIENCE_STATES = [
  "SIGNED_OUT",
  "REINSTALLING",
  "SUPPORT_ONLY",
  "ONBOARDING",
  "ACTIVE",
  "NO_CONTRACT",
  "FROZEN",
  "BILLING_ATTENTION",
] as const;

export type MerchantExperienceState =
  (typeof MERCHANT_EXPERIENCE_STATES)[number];

export const MERCHANT_SURFACES = [
  "HOME",
  "USAGE",
  "BILLING_OPTIONS",
  "BILLING_PURCHASE_HISTORY",
  "PROMOTIONS",
  "RECOVERY_SETTINGS",
  "RECOVERY_HISTORY",
  "SUPPORT",
  "PLAN_SELECT",
  "PENDING_RECOVERIES",
] as const;

export type MerchantSurface = (typeof MERCHANT_SURFACES)[number];

type MerchantShop = {
  status: string;
  reinstallPendingAt?: Date | string | null;
};

type MerchantSettings =
  | {
      onboardingCompleted?: boolean | null;
    }
  | null
  | undefined;

type MerchantSubscription =
  | {
      status?: string | null;
    }
  | null
  | undefined;

export type MerchantRouteAccessInput = {
  shop: MerchantShop;
  settings?: MerchantSettings;
  subscription?: MerchantSubscription;
};

export type MerchantNavigationItem = {
  id:
    | "home"
    | "recoveries"
    | "billing"
    | "support"
    | "promotions"
    | "recoverySettings";
  href: string;
};

const surfaceMatrix: Record<
  MerchantExperienceState,
  readonly MerchantSurface[]
> = {
  SIGNED_OUT: [],
  REINSTALLING: ["SUPPORT"],
  SUPPORT_ONLY: ["SUPPORT"],
  ONBOARDING: ["HOME", "SUPPORT", "PLAN_SELECT"],
  ACTIVE: [
    "HOME",
    "USAGE",
    "BILLING_OPTIONS",
    "BILLING_PURCHASE_HISTORY",
    "PROMOTIONS",
    "RECOVERY_SETTINGS",
    "RECOVERY_HISTORY",
    "SUPPORT",
    "PLAN_SELECT",
    "PENDING_RECOVERIES",
  ],
  NO_CONTRACT: [
    "HOME",
    "USAGE",
    "BILLING_OPTIONS",
    "BILLING_PURCHASE_HISTORY",
    "SUPPORT",
    "PLAN_SELECT",
    "RECOVERY_HISTORY",
  ],
  FROZEN: [
    "HOME",
    "USAGE",
    "BILLING_OPTIONS",
    "BILLING_PURCHASE_HISTORY",
    "SUPPORT",
    "RECOVERY_HISTORY",
  ],
  BILLING_ATTENTION: [
    "HOME",
    "USAGE",
    "BILLING_OPTIONS",
    "BILLING_PURCHASE_HISTORY",
    "SUPPORT",
    "PLAN_SELECT",
    "RECOVERY_HISTORY",
  ],
};

const navigationByState: Record<
  MerchantExperienceState,
  readonly MerchantNavigationItem[]
> = {
  SIGNED_OUT: [],
  REINSTALLING: [{ id: "support", href: "/app/merchant-support" }],
  SUPPORT_ONLY: [{ id: "support", href: "/app/merchant-support" }],
  ONBOARDING: [
    { id: "home", href: "/app" },
    { id: "support", href: "/app/merchant-support" },
  ],
  ACTIVE: [
    { id: "home", href: "/app" },
    { id: "recoveries", href: "/app/recoveries" },
    { id: "billing", href: "/app/billing/options" },
    { id: "promotions", href: "/app/promotions" },
    { id: "support", href: "/app/merchant-support" },
    { id: "recoverySettings", href: "/app/recovery-settings" },
  ],
  NO_CONTRACT: historyNavigation(),
  FROZEN: historyNavigation(),
  BILLING_ATTENTION: historyNavigation(),
};
function historyNavigation(): MerchantNavigationItem[] {
  return [
    { id: "home", href: "/app" },
    { id: "recoveries", href: "/app/recoveries" },
    { id: "billing", href: "/app/billing/options" },
    { id: "support", href: "/app/merchant-support" },
  ];
}

export function resolveMerchantExperienceState({
  shop,
  settings,
  subscription,
}: MerchantRouteAccessInput): MerchantExperienceState {
  if (shop.status === "UNINSTALLED" && shop.reinstallPendingAt != null)
    return "REINSTALLING";
  if (shop.status === "SUSPENDED") return "SUPPORT_ONLY";
  if (shop.status !== "ACTIVE") return "SIGNED_OUT";
  if (settings?.onboardingCompleted !== true) return "ONBOARDING";

  switch (subscription?.status) {
    case "ACTIVE":
    case "TRIALING":
      return "ACTIVE";
    case "NO_CONTRACT":
      return "NO_CONTRACT";
    case "FROZEN":
      return "FROZEN";
    default:
      return "BILLING_ATTENTION";
  }
}

export function canAccessMerchantSurface(
  state: MerchantExperienceState,
  surface: MerchantSurface,
): boolean {
  return surfaceMatrix[state].includes(surface);
}

export function getMerchantDeniedRedirect(
  state: MerchantExperienceState,
  surface: MerchantSurface,
): string {
  if (state === "REINSTALLING") return "/app/reinstalling";
  if (state === "SUPPORT_ONLY") return "/app/merchant-support";
  if (state === "SIGNED_OUT") return "/auth/login";
  if (state === "FROZEN" && surface === "PLAN_SELECT")
    return "/app/billing/options";
  return "/app";
}

export function getMerchantNavigation(
  state: MerchantExperienceState,
): readonly MerchantNavigationItem[] {
  return navigationByState[state];
}
