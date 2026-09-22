import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import RecoverySettingsView from "../../../app/routes/app/recovery-settings/RecoverySettingsView";
const scenario = new URLSearchParams(location.search).get("scenario") ?? "free";
const merchant = {
  recoveryDelayMinutes: 30,
  recoveryOfferMode: "NONE" as const,
  fixedShopifyDiscountId: null,
  followUpEnabled: true,
  followUpDelayMinutes: 60,
  source: "MERCHANT" as const,
};
const data = {
  merchant,
  effective:
    scenario === "override"
      ? {
          ...merchant,
          recoveryOfferMode: "AI_BEST_APPLICABLE" as const,
          source: "ADMIN_OVERRIDE" as const,
        }
      : merchant,
  revision: "fixture-revision",
  overrideActive: scenario === "override",
  catalogueStatus: "UNAVAILABLE" as const,
  discounts: [],
  merchantFixedDiscount: null,
  effectiveFixedDiscount: null,
  merchantUi: { locale: "en", fallbackLocale: "en", timeZone: "UTC" },
  features: {
    revision: "fixture-features",
    features:
      scenario === "empty"
        ? []
        : [
            {
              id: "ai",
              key: "ai_conversations",
              name: "AI Conversations",
              description: "AI-assisted merchant and customer conversations.",
              editable: false,
              enabled: true,
              effective: true,
            },
            {
              id: "checkout",
              key: "checkout_recovery",
              name: "Checkout Recovery",
              description: "Recover abandoned checkouts.",
              editable: false,
              enabled: true,
              effective: true,
            },
            {
              id: "orders",
              key: "order_support",
              name: "Order Support",
              description: "Support order-related customer conversations.",
              editable: true,
              enabled: true,
              effective: true,
            },
            {
              id: "products",
              key: "product_search",
              name: "Product Search",
              description: "Search merchant products during customer conversations.",
              editable: true,
              enabled: scenario === "paid",
              effective: scenario === "paid",
            },
          ],
  },
};
// Isolated fixture server only: never authenticates or writes a merchant record.
window.fetch = async (_url, options) => {
  const body = options?.body as FormData;
  await new Promise((r) => setTimeout(r, 600));
  return Response.json({
    ok: true,
    operationId: body.get("operationId"),
    revision: "saved-fixture",
  });
};
document.body.style.cssText =
  "margin:0;padding:24px;background:#f5f6f8;font-family:Arial,sans-serif;color:#202223";
const banner = document.createElement("nav");
banner.innerHTML =
  "<strong>Embedded merchant settings · " +
  scenario +
  '</strong> · <a href="?scenario=free">Free</a> · <a href="?scenario=paid">Paid</a> · <a href="?scenario=override">Override</a> · <a href="?scenario=empty">No eligible features</a>';
document.body.prepend(banner);
const router = createMemoryRouter([
  { path: "*", element: <RecoverySettingsView data={data as never} /> },
]);
createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />,
);
