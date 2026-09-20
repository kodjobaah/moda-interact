import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  useLoaderData,
  useNavigation,
  useRevalidator,
  Link,
  redirect,
} from "react-router";
import RecoveryOverview, {
  type OverviewProps,
} from "../../../app/components/dashboard/RecoveryOverview";
import LegacyBillingUnavailable from "../../../app/components/dashboard/LegacyBillingUnavailable";
import Onboarding from "../../../app/components/onboarding/Onboarding";
import { overviewFixture } from "../../fixtures/recovery-overview";
import RecoveryList from "../../../app/routes/app/recoveries/RecoveryList";
const states = [
  "ACTIVE",
  "ONBOARDING",
  "NO_CONTRACT",
  "FROZEN",
  "BILLING_ATTENTION",
  "EMPTY",
  "UNAVAILABLE",
  "ERROR",
  "LOADING",
  "RTL",
];
const initial = new URLSearchParams(location.search);
// Synthetic fixture state only. Production loader authorization/redirects are covered by home-route.test.ts.
let scenario = initial.get("fixture") ?? "ACTIVE";
const catalogue = [
  {
    shopifyPlanHandle: "fixture-free",
    displayName: "Fixture Free",
    planKind: "FREE",
    featured: false,
    cataloguePosition: 0,
    usageEvents: [],
    localizedDescription: "Synthetic plan for local validation",
    includedRecoveryCredits: 10,
    allowancePeriod: "LIFETIME",
    recurringAmountMinor: 0,
    currency: "GBP",
    billingPeriod: "LIFETIME",
    highlights: [],
  },
];
function dataFor(request: Request): OverviewProps {
  const url = new URL(request.url);
  scenario = url.searchParams.get("fixture") ?? scenario;
  const data = overviewFixture();
  data.merchantExperienceState = scenario;
  data.merchantUi.locale =
    initial.get("locale") ?? (scenario === "RTL" ? "ar" : "en-GB");
  data.pricingCatalogue = catalogue;
  data.performance.filters.from = url.searchParams.get("from") ?? "2026-09-01";
  data.performance.filters.to = url.searchParams.get("to") ?? "2026-09-20";
  data.pendingRecoveries.available = [
    "ACTIVE",
    "EMPTY",
    "UNAVAILABLE",
    "ERROR",
    "LOADING",
    "RTL",
  ].includes(scenario);
  data.pendingRecoveriesUpdatedAt = "2026-09-20T10:00:00Z";
  data.capacity = {
    availability:
      scenario === "FROZEN"
        ? "CONTRACT_FROZEN"
        : scenario === "NO_CONTRACT"
          ? "CONTRACT_REQUIRED"
          : "AVAILABLE",
    canStartRecovery: scenario === "ACTIVE",
    freeLifetime: { remaining: 6, granted: 10, reserved: 1 },
    paidIncluded: {
      remaining: 70,
      granted: 100,
      reserved: 2,
      periodEnd: "2026-10-01T00:00:00Z",
    },
    promotional: { remaining: 5, reserved: 1 },
    purchased: { available: 12, reserved: 3, refunding: 2 },
  } as OverviewProps["capacity"];
  data.performance.overview!.preview = Array.from({ length: 5 }, (_, i) => ({
    ...data.performance.overview!.preview[0],
    id: `basket-${i + 1}`,
    status: i < 3 ? "COMPLETED" : "ENGAGED",
    totalPrice: i === 0 ? "25.10" : i === 1 ? "40.20" : null,
    currency: i === 0 ? "GBP" : i === 1 ? "EUR" : null,
    customer: {
      displayName: i === 4 ? "عميل تجريبي" : `Ada ${i + 1}`,
      email: null,
    },
  }));
  if (scenario === "EMPTY") {
    Object.assign(data.performance.overview!.summary, {
      started: 0,
      recovered: 0,
      ongoing: 0,
      recoveryRate: null,
      recoveredValues: [],
      unknownValueCount: 0,
    });
    data.performance.overview!.preview = [];
  }
  if (scenario === "UNAVAILABLE") data.capacity = null;
  if (scenario === "ERROR") {
    data.performance.state = "error";
    data.performance.overview = null;
  }
  if (scenario === "BILLING_ATTENTION") {
    data.capacity!.availability = "CONFIGURATION_UNAVAILABLE";
    data.billingSetup = {
      phase: "FINALIZING_SUBSCRIPTION",
      planName: "Fixture Free",
      planHandle: "fixture-free",
      currentPeriodStart: "2026-09-01T00:00:00Z",
      currentPeriodEnd: "2026-10-01T00:00:00Z",
      lastSyncedAt: "2026-09-20T10:00:00Z",
    };
  }
  return data;
}
function Screen() {
  const data = useLoaderData() as OverviewProps & {
    legacyBillingUnavailable?: boolean;
  };
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  if (data.legacyBillingUnavailable)
    return (
      <LegacyBillingUnavailable
        merchantUi={data.merchantUi}
        embed={data.performance.embed}
      />
    );
  return (
    <>
      <nav className="fixture-controls" aria-label="Fixture scenarios">
        {states.map((state) => (
          <Link key={state} to={`/app?fixture=${state}`}>
            {state}
          </Link>
        ))}
        <Link to="/app?view=detail&bill=past&billId=fixture-period">
          Legacy billing
        </Link>
        <Link to="/app?view=detail&bill=past&billId=missing-period">
          Unavailable legacy billing
        </Link>
      </nav>
      {scenario === "ONBOARDING" ? (
        <Onboarding merchantUi={data.merchantUi} pricingCatalogue={catalogue} />
      ) : (
        <RecoveryOverview
          {...data}
          busy={scenario === "LOADING" || navigation.state !== "idle"}
          onRefresh={() => revalidator.revalidate()}
        />
      )}
    </>
  );
}
function List() {
  const data = useLoaderData() as OverviewProps;
  return (
    <RecoveryList
      data={{
        ...data.performance,
        merchantUi: { ...data.merchantUi, fallbackLocale: "en" },
        page: {
          items: data.performance.overview!.preview,
          previousCursor: null,
          nextCursor: null,
        },
        state: "ready",
        error: null,
      }}
      onRefresh={() => {}}
    />
  );
}
createRoot(document.getElementById("root")!).render(
  <RouterProvider
    router={createBrowserRouter([
      {
        path: "/app",
        loader: ({ request }) => {
          const data = dataFor(request);
          const url = new URL(request.url);
          if (
            url.searchParams.get("view") === "detail" &&
            scenario !== "ONBOARDING"
          ) {
            const ids = url.searchParams.getAll("billId");
            if (ids.length && (ids.length !== 1 || ids[0] !== "fixture-period"))
              return { ...data, legacyBillingUnavailable: true };
            return redirect(
              `/app/usage?bill=${url.searchParams.get("bill") === "past" ? "past" : "current"}&billId=fixture-period&shop=fixture.myshopify.com`,
            );
          }
          return data;
        },
        Component: Screen,
      },
      {
        path: "/app/recoveries",
        loader: ({ request }) => dataFor(request),
        Component: List,
      },
      {
        path: "/app/recoveries/:id",
        element: (
          <main>
            <h1>Recovery detail fixture destination</h1>
            <Link to={`/app/recoveries${location.search}`}>
              Back to recoveries
            </Link>
          </main>
        ),
      },
      {
        path: "/app/usage",
        element: (
          <main>
            <h1>Billing usage fixture destination</h1>
            <p>Legacy billing context preserved in the URL.</p>
          </main>
        ),
      },
    ])}
  />,
);
