export const mockPlans = [
  { id: "free", name: "Free", rank: 0, monthlyPriceMinor: 0, currency: "GBP", includedConversations: 5, allowanceType: "lifetime" },
  { id: "starter", name: "Starter", rank: 1, monthlyPriceMinor: 3500, currency: "GBP", includedConversations: 100, allowanceType: "monthly" },
  { id: "growth", name: "Growth", rank: 2, monthlyPriceMinor: 7500, currency: "GBP", includedConversations: 250, allowanceType: "monthly" },
  { id: "scale", name: "Scale", rank: 3, monthlyPriceMinor: 14900, currency: "GBP", includedConversations: 500, allowanceType: "monthly" },
];

export const mockTopUpOffers = [
  { id: "free-5", planId: "free", chargeAmountMinor: 500, currency: "GBP", creditsGranted: 10 },
  { id: "free-10", planId: "free", chargeAmountMinor: 1000, currency: "GBP", creditsGranted: 22 },
  { id: "free-20", planId: "free", chargeAmountMinor: 2000, currency: "GBP", creditsGranted: 50 },
  { id: "starter-5", planId: "starter", chargeAmountMinor: 500, currency: "GBP", creditsGranted: 15 },
  { id: "starter-10", planId: "starter", chargeAmountMinor: 1000, currency: "GBP", creditsGranted: 32 },
  { id: "starter-20", planId: "starter", chargeAmountMinor: 2000, currency: "GBP", creditsGranted: 70 },
  { id: "growth-5", planId: "growth", chargeAmountMinor: 500, currency: "GBP", creditsGranted: 18 },
  { id: "growth-10", planId: "growth", chargeAmountMinor: 1000, currency: "GBP", creditsGranted: 40 },
  { id: "growth-20", planId: "growth", chargeAmountMinor: 2000, currency: "GBP", creditsGranted: 90 },
  { id: "scale-5", planId: "scale", chargeAmountMinor: 500, currency: "GBP", creditsGranted: 20 },
  { id: "scale-10", planId: "scale", chargeAmountMinor: 1000, currency: "GBP", creditsGranted: 45 },
  { id: "scale-20", planId: "scale", chargeAmountMinor: 2000, currency: "GBP", creditsGranted: 100 },
];

export const mockBillingState = { currentPlanId: "starter", monthlyUsed: 84, purchasedCreditsAvailable: 18 };
