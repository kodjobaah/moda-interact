import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import RecoveryList from "../../../app/routes/app/recoveries/RecoveryList";
import type { RecoveryListData } from "../../../app/routes/app/recoveries/recovery-list-state";

let reads = 0;
function Fixture() {
  const data = useLoaderData() as RecoveryListData;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  return (
    <RecoveryList
      data={data}
      busy={navigation.state !== "idle" || revalidator.state !== "idle"}
      onRefresh={() => revalidator.revalidate()}
    />
  );
}
const loader = async ({
  request,
}: {
  request: Request;
}): Promise<RecoveryListData> => {
  const params = new URL(request.url).searchParams;
  await new Promise((resolve) => setTimeout(resolve, 350));
  const fixture = params.get("fixture");
  const filters = {
    from: params.get("from") ?? "2026-08-22",
    to: params.get("to") ?? "2026-09-20",
    q: params.get("q") ?? "",
    status: (params.get("status") ??
      "all") as RecoveryListData["filters"]["status"],
    pageSize: 25,
    cursor: params.get("cursor"),
  };
  const all = [
    {
      id: "fixture-1",
      customer: { displayName: "Ada Lovelace", email: "ada@example.test" },
      status: "COMPLETED" as const,
      totalPrice: "134.50",
      currency: "GBP",
      detectedAt: "2026-09-20T08:30:00.000Z",
      displayLabel: {
        kind: "checkout" as const,
        detectedAt: "2026-09-20T08:30:00.000Z",
      },
    },
    {
      id: "fixture-2",
      customer: {
        displayName: "ليلى أحمد",
        email: "long.customer.address@example.test",
      },
      status: "ENGAGED" as const,
      totalPrice: "219.00",
      currency: "EUR",
      detectedAt: "2026-09-19T15:12:00.000Z",
      displayLabel: {
        kind: "checkout" as const,
        detectedAt: "2026-09-19T15:12:00.000Z",
      },
    },
    {
      id: "fixture-3",
      customer: null,
      status: "DETECTED" as const,
      totalPrice: null,
      currency: null,
      detectedAt: "2026-09-18T10:04:00.000Z",
      displayLabel: {
        kind: "checkout" as const,
        detectedAt: "2026-09-18T10:04:00.000Z",
      },
    },
  ];
  const items = all.filter(
    (row) =>
      (!filters.q ||
        JSON.stringify(row.customer)
          .toLowerCase()
          .includes(filters.q.toLowerCase())) &&
      (filters.status === "all" ||
        (filters.status === "ongoing"
          ? row.status !== "COMPLETED"
          : row.status === filters.status)) &&
      row.detectedAt.slice(0, 10) >= filters.from &&
      row.detectedAt.slice(0, 10) <= filters.to,
  );
  const page = {
    items: filters.cursor ? items.slice(2) : items.slice(0, 2),
    previousCursor: filters.cursor ? "fixture-previous" : null,
    nextCursor: !filters.cursor && items.length > 2 ? "fixture-next" : null,
  };
  if (filters.cursor === "fixture-previous") {
    page.items = items.slice(0, 2);
    page.previousCursor = null;
    page.nextCursor = items.length > 2 ? "fixture-next" : null;
  }
  const state =
    fixture === "error" && reads++ === 0
      ? "error"
      : fixture === "never"
        ? "never-used"
        : fixture === "invalid"
          ? "invalid"
          : fixture === "empty" || !items.length
            ? "empty"
            : "ready";
  return {
    merchantUi: {
      locale: params.get("locale") ?? "en-GB",
      timeZone: "Europe/London",
      fallbackLocale: "en-GB",
    },
    filters,
    embed: { shop: "fixture.myshopify.com", host: "Zml4dHVyZQ", embedded: "1" },
    today: "2026-09-20",
    presets: { today: "2026-09-20", week: "2026-09-14", month: "2026-08-22" },
    page:
      state === "ready"
        ? page
        : { items: [], previousCursor: null, nextCursor: null },
    state,
    error: state === "invalid" ? "date" : null,
  };
};
const root = createRoot(document.getElementById("root")!);
root.render(
  <RouterProvider
    router={createBrowserRouter([{ path: "*", loader, element: <Fixture /> }])}
  />,
);
