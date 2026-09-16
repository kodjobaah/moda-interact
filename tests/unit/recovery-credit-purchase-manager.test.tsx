import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RecoveryCreditPurchaseManager from "../../app/components/dashboard/RecoveryCreditPurchaseManager";

const routeSource = await readFile(
  new URL(
    "../../app/routes/app/billing/recovery-credit-purchases/route.tsx",
    import.meta.url,
  ),
  "utf8",
);
const managerSource = await readFile(
  new URL(
    "../../app/components/dashboard/RecoveryCreditPurchaseManager.jsx",
    import.meta.url,
  ),
  "utf8",
);
const routesSource = await readFile(
  new URL("../../app/routes.ts", import.meta.url),
  "utf8",
);

let filter = "ALL";

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ state: "idle", data: null, submit: vi.fn() }),
    useRevalidator: () => ({ revalidate: vi.fn() }),
    useSearchParams: () => [new URLSearchParams({ filter }), vi.fn()],
  };
});

const merchantUi = { locale: "en-GB", fallbackLocale: "en", timeZone: "UTC" };
const date = "2026-09-14T00:00:00.000Z";

function purchase(
  id: string,
  status: string,
  availableAmount: number,
  correctionId: string | null = null,
) {
  return {
    id,
    status,
    createdAt: date,
    activatedAt: date,
    creditsGranted: 5,
    currentAmount: availableAmount,
    reservedAmount: availableAmount === 0 ? 1 : 0,
    availableAmount,
    planName: "Growth",
    planHandle: "growth",
    originalProviderPurchase: { amount: "12.50", currency: "USD" },
    latestRefund:
      status === "WITHDRAWN"
        ? { status: "REQUESTED", automaticCorrectionUsageEventId: correctionId }
        : null,
    completedRefund:
      status === "REFUNDED"
        ? {
            finalCreditQuantity: 2,
            expectedProviderAmount: "5.00",
            expectedProviderCurrency: "USD",
            completedAt: date,
          }
        : null,
    refundEligible: id === "historical" ? false : null,
  };
}

function render() {
  return renderToStaticMarkup(
    <RecoveryCreditPurchaseManager
      merchantUi={merchantUi}
      filter={filter}
      page={{
        page: 1,
        pageSize: 20,
        total: 5,
        purchases: [
          purchase("requested", "REQUESTED", 0),
          purchase("active", "ACTIVE", 2),
          purchase("historical", "ACTIVE", 2),
          purchase("empty-active", "ACTIVE", 0),
          purchase("withdrawn", "WITHDRAWN", 0),
          purchase("completed", "COMPLETED", 0),
          purchase("refunded", "REFUNDED", 0),
        ],
      }}
    />,
  );
}

describe("purchased credit history manager", () => {
  it("renders every lifecycle state, keeps REQUESTED non-selectable, and omits provider identifiers", () => {
    filter = "ALL";
    const markup = render();

    expect(markup).toContain("Awaiting Shopify confirmation");
    expect(markup).toContain("Active");
    expect(markup).toContain("Refund pending");
    expect(markup).toContain("Completed");
    expect(markup).toContain("Refunded");
    expect(markup).toContain("No credits are available to refund");
    expect(markup).toContain(
      "no longer refundable under the current subscription",
    );
    expect(markup).toContain("Reactivate credits");
    expect(markup).toContain("All purchased credits have been used.");
    expect(markup).toContain("Credits refunded: 2");
    expect(markup).not.toContain("5.00");
    expect(markup).not.toContain("providerSubscriptionId");
    expect(markup).not.toContain("billingPeriodId");
  });

  it("keeps refund requests server-authoritative and bounded to unique purchase IDs", () => {
    expect(managerSource).toContain(
      'form.set("requestId", crypto.randomUUID())',
    );
    expect(managerSource).toContain("selectedPurchases.forEach");
    expect(managerSource).toContain('form.append("purchaseId", purchase.id)');
    expect(managerSource).not.toContain('form.set("quantity"');
    expect(managerSource).not.toContain('form.set("amount"');
    expect(managerSource).not.toContain('form.set("currency"');
    expect(routeSource).toContain("purchaseIds.length > 20");
    expect(routeSource).toContain(
      "session.onlineAccessInfo?.associated_user?.id",
    );
  });

  it("uses authenticated shop resolution and separate read/manage capabilities", () => {
    expect(routeSource).toContain("await authenticate.admin(request)");
    expect(routeSource).toContain('capability: "read-billing"');
    expect(routeSource).toContain('capability: "manage-billing"');
    expect(routeSource).toContain("shopId: shop.id");
    expect(routesSource).toContain('route("billing/recovery-credit-purchases"');
    expect(routeSource).toContain("FILTER_TO_STATUS");
    expect(routeSource).toContain(
      'resolvePurchaseHistoryFilter(url.searchParams.get("filter"))',
    );
    expect(managerSource).toContain("const visible = purchases;");
    expect(managerSource).not.toContain(
      "purchases.filter((purchase) => purchase.status === filter)",
    );
  });

  it("keeps server-provided rows visible and preserves the canonical filter during pagination", () => {
    filter = "ALL";
    const markup = render();
    expect(markup).toContain("Awaiting Shopify confirmation");
    expect(managerSource).toContain(
      "setSearchParams({ filter, page: String((page?.page ?? 1) - 1) })",
    );
    expect(managerSource).toContain(
      "setSearchParams({ filter, page: String((page?.page ?? 1) + 1) })",
    );
  });

  it("blocks reactivation after Background links an automatic correction", () => {
    const markup = renderToStaticMarkup(
      <RecoveryCreditPurchaseManager
        merchantUi={merchantUi}
        filter="ALL"
        page={{
          page: 1,
          pageSize: 20,
          total: 1,
          purchases: [purchase("corrected", "WITHDRAWN", 0, "usage-event-1")],
        }}
      />,
    );
    expect(markup).toContain("Refund pending");
    expect(markup).toContain(
      "This refund can no longer be cancelled in-app because settlement may have started.",
    );
    expect(markup).not.toContain("Reactivate credits");
  });
});
