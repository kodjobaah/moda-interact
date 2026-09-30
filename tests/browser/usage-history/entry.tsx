import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  Link,
  useLoaderData,
  useRevalidator,
  useNavigation,
} from "react-router";
import MerchantNavigation from "../../../app/components/dashboard/MerchantNavigation";
import UsageEvents, {
  type UsageData,
} from "../../../app/components/dashboard/UsageEvents";
import {
  MERCHANT_EXPERIENCE_STATES,
  canAccessMerchantSurface,
  type MerchantExperienceState,
} from "../../../app/services/shop/merchant-route-access-policy";
import { usageFixture } from "../../fixtures/usage-history";
// Render Shopify link text/hrefs locally without loading the authenticated App Bridge shell.
customElements.define(
  "s-link",
  class extends HTMLElement {
    connectedCallback() {
      const link = document.createElement("a");
      link.href = this.getAttribute("href") ?? "";
      while (this.firstChild) link.append(this.firstChild);
      this.append(link);
    }
  },
);
function Screen() {
  const { data, state } = useLoaderData() as {
    data: UsageData;
    state: MerchantExperienceState;
  };
  const r = useRevalidator();
  const n = useNavigation();
  return (
    <>
      <div className="fixture-controls">
        {MERCHANT_EXPERIENCE_STATES.map((s) => (
          <Link key={s} to={`/app/usage?fixture=${s}`}>
            {s}
          </Link>
        ))}
        <Link to="/app/usage?bill=past&billId=missing">Unknown period</Link>
      </div>
      <MerchantNavigation
        state={state}
        unread={3}
        merchantUi={data.merchantUi}
      />
      {canAccessMerchantSurface(state, "USAGE") ? (
        <UsageEvents
          {...data}
          busy={n.state !== "idle"}
          onRefresh={() => r.revalidate()}
        />
      ) : (
        <p>History access denied in this fixture state.</p>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <RouterProvider
    router={createBrowserRouter([
      {
        path: "/app/usage",
        loader: ({ request }) => {
          const p = new URL(request.url).searchParams;
          const state = (p.get("fixture") ??
            "ACTIVE") as MerchantExperienceState;
          const data = usageFixture();
          const history = data.history!;
          data.merchantUi.locale = p.get("locale") ?? "en-GB";
          history.usageView = p.get("bill") === "past" ? "past" : "current";
          history.periodPage.items = Array.from({ length: 25 }, (_, i) => ({
            id: `period-${i + 1 + (p.get("periodCursor") === "fixture-next" ? 25 : 0)}`,
            status: history.usageView === "past" ? "CLOSED" : "OPEN",
            periodStart: new Date(
              Date.UTC(
                2026,
                8 - i - (p.get("periodCursor") === "fixture-next" ? 25 : 0),
                1,
              ),
            ).toISOString(),
            periodEnd: new Date(
              Date.UTC(
                2026,
                9 - i - (p.get("periodCursor") === "fixture-next" ? 25 : 0),
                1,
              ),
            ).toISOString(),
          }));
          history.periodPage.nextCursor =
            p.get("periodCursor") === "fixture-next" ? null : "fixture-next";
          history.periodPage.previousCursor =
            p.get("periodCursor") === "fixture-next"
              ? "fixture-previous"
              : null;
          history.periodCursor = p.get("periodCursor");
          history.usagePagination.page = Number(p.get("page") ?? 1);
          history.usagePagination.total = 22;
          history.usagePagination.totalQuantity = 33;
          const sample = history.usageEvents;
          history.usageEvents = Array.from(
            {
              length: Math.min(
                10,
                Math.max(0, 22 - (history.usagePagination.page - 1) * 10),
              ),
            },
            (_, i) => ({
              ...sample[i % 2],
              id: `event-${history.usagePagination.page}-${i}`,
            }),
          );

          if (p.has("billId") && p.get("billId") === "missing") {
            history.state = "unavailable";
            history.usageEvents = [];
            history.usagePagination.billId = null;
            history.selection = { billId: "" };
          } else if (p.has("billId")) {
            history.selection = { billId: p.get("billId")! };
            history.usagePagination.billId = p.get("billId");
            const index = Number(p.get("billId")!.replace("period-", "")) - 1;
            history.usagePagination.periodStart = new Date(
              Date.UTC(2026, 8 - index, 1),
            ).toISOString();
            history.usagePagination.periodEnd = new Date(
              Date.UTC(2026, 9 - index, 1),
            ).toISOString();
          }
          return { data, state };
        },
        Component: Screen,
      },
      {
        path: "*",
        element: (
          <main>
            <h1>Fixture destination</h1>
            <p>Inspect the URL for the production link destination.</p>
          </main>
        ),
      },
    ])}
  />,
);
