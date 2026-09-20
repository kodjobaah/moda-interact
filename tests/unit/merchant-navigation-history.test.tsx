import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, it, expect } from "vitest";
import MerchantNavigation from "../../app/components/dashboard/MerchantNavigation";
import UsageEvents from "../../app/components/dashboard/UsageEvents";
import { usageFixture } from "../fixtures/usage-history";
import { MERCHANT_EXPERIENCE_STATES } from "../../app/services/shop/merchant-route-access-policy";
function renderUsage(data = usageFixture()) {
  return renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter(
        [
          {
            path: "/app/usage",
            element: <UsageEvents {...data} onRefresh={() => {}} />,
          },
        ],
        { initialEntries: ["/app/usage"] },
      )}
    />,
  );
}
describe("merchant navigation and history links", () => {
  it.each(MERCHANT_EXPERIENCE_STATES)(
    "renders localized navigation without stale Messages label for %s",
    (state) => {
      const html = renderToStaticMarkup(
        <MerchantNavigation
          state={state}
          unread={3}
          merchantUi={usageFixture().merchantUi}
        />,
      );
      expect(html).not.toContain("Messages");
      if (state === "SIGNED_OUT") expect(html).not.toContain("<s-link");
      else expect(html).toContain("Support (3)");
      if (state === "ONBOARDING") {
        expect(html).toContain(">Home<");
        expect(html).not.toContain("/app/usage");
        expect(html).not.toContain("/app/billing/options");
      }
      if (state === "ACTIVE")
        expect(html.indexOf(">Overview<")).toBeLessThan(
          html.indexOf(">Recoveries<"),
        );
    },
  );
  it("links billing breadcrumb and owned recovery directly, with safe unresolved fallback", () => {
    const html = renderUsage().replaceAll("&amp;", "&");
    expect(html).toContain("/app/billing/options?shop=fixture.myshopify.com");
    expect(html).toContain(
      "/app/recoveries/owned-recovery?shop=fixture.myshopify.com",
    );
    expect(html).toContain("Checkout ·");
    expect(html).not.toContain(">owned-recovery<");
    expect(html).not.toContain("view=detail");
    expect(html).toContain("Usage history");
    expect(html).toContain("accounting-event-2");
  });
  it("keeps unavailable periods explicit and allows deliberate period selection", () => {
    const data = usageFixture();
    data.history!.state = "unavailable";
    data.history!.selection = { billId: "" };
    data.history!.usageEvents = [];
    data.history!.usagePagination.billId = null;
    const html = renderUsage(data);
    expect(html).toContain("No other period has been selected");
    expect(html).not.toContain("<table");
    expect(html).toContain("billId=period-1");
  });
  it("keeps source links scoped to the currently displayed page", () => {
    const data = usageFixture();
    data.history!.usagePagination.total = 100;
    data.history!.usagePagination.page = 2;
    const html = renderUsage(data).replaceAll("&amp;", "&");
    expect(html).toContain("page=1");
    expect(html).toContain("page=3");
    expect(html).toContain("billId=period-1");
  });
});
