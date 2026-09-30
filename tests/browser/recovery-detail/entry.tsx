import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  ScrollRestoration,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import RecoveryDetail from "../../../app/routes/app/recovery-detail/RecoveryDetail";
import RecoveryList from "../../../app/routes/app/recoveries/RecoveryList";
import type {
  DetailData,
  Messages,
  Related,
} from "../../../app/routes/app/recovery-detail/state";
import type { RecoveryListData } from "../../../app/routes/app/recoveries/recovery-list-state";
import { recoveryScrollKey } from "../../../app/routes/app/recoveries/recovery-list-state";
const merchantUi = {
  locale: new URLSearchParams(location.search).get("locale") ?? "en-GB",
  timeZone: "Europe/London",
  fallbackLocale: "en",
};
const embed = { shop: "fixture.myshopify.com" };
const filters = (request: Request) => {
  const q = new URL(request.url).searchParams;
  return {
    from: q.get("from") ?? "2026-09-01",
    to: q.get("to") ?? "2026-09-20",
    q: q.get("q") ?? "",
    status: "all" as const,
    pageSize: 25,
    cursor: q.get("cursor"),
  };
};
const rows = Array.from({ length: 9 }, (_, i) => ({
  id: `basket-${i + 1}`,
  detectedAt: `2026-09-${String(20 - i).padStart(2, "0")}T09:00:00.000Z`,
  status: "ENGAGED" as const,
  totalPrice: "134.50",
  currency: "GBP",
  customer: { displayName: "Ada Lovelace", email: "ada@example.test" },
  displayLabel: {
    kind: "checkout" as const,
    detectedAt: "2026-09-20T09:00:00.000Z",
  },
}));
const messages: Messages["items"] = Array.from({ length: 125 }, (_, i) => ({
  id: `message-${i + 1}`,
  createdAt: new Date(Date.UTC(2026, 8, 19, 23, 30 + i)).toISOString(),
  direction: i % 2 ? "OUTBOUND" : "INBOUND",
  sender: (["CUSTOMER", "AGENT", "AUTOMATION", "HUMAN", null] as const)[i % 5],
  content:
    i === 3
      ? {
          type: "AUDIO",
          transcriptionStatus: "COMPLETED",
          text: "Can I change the delivery address?",
        }
      : i === 4
        ? { type: "AUDIO", transcriptionStatus: "REJECTED", text: null }
        : i === 5
          ? { type: "UNSUPPORTED", transcriptionStatus: null, text: null }
          : {
              type: "TEXT",
              transcriptionStatus: null,
              text: `Message ${i + 1} · ${i % 2 ? "Your checkout is ready whenever you are." : "مرحبا، هل يمكن توصيل الطلب غدًا؟"}${i === 0 ? " https://example.test/" + "long-path-".repeat(25) + " <script>alert(1)</script>" : ""}`,
            },
  delivery:
    i % 2
      ? {
          status: "DELIVERED",
          sentAt: new Date(Date.UTC(2026, 8, 19, 23, 30 + i)).toISOString(),
          deliveredAt: null,
          readAt: null,
        }
      : null,
}));
function messagePage(q = new URLSearchParams()): Messages {
  const start =
    q.get("window") === "latest" ? 75 : Number(q.get("cursor") ?? 0);
  return {
    items: messages.slice(start, start + 50),
    previousCursor: start ? String(Math.max(0, start - 50)) : null,
    nextCursor: start + 50 < 125 ? String(start + 50) : null,
  };
}
function relatedPage(id: string, q = new URLSearchParams()): Related {
  const items = rows.filter((r) => r.id !== id);
  const start = Number(q.get("cursor") ?? 0);
  return {
    items: items.slice(start, start + 5).map((r) => ({
      id: r.id,
      status: r.status,
      detectedAt: r.detectedAt,
      value: {
        amount: r.totalPrice,
        currency: r.currency,
        incomplete: false,
      },
    })),
    previousCursor: start ? "0" : null,
    nextCursor: start + 5 < items.length ? "5" : null,
  };
}
function DetailFixture() {
  const data = useLoaderData() as DetailData;
  const n = useNavigation(),
    r = useRevalidator();
  return (
    <RecoveryDetail
      key={data.detail?.id ?? data.state}
      data={data}
      busy={n.state !== "idle"}
      onRefresh={() => r.revalidate()}
    />
  );
}
function ListFixture() {
  const data = useLoaderData() as RecoveryListData;
  const r = useRevalidator();
  return <RecoveryList data={data} onRefresh={() => r.revalidate()} />;
}
let failed = false;
const router = createBrowserRouter([
  {
    element: (
      <>
        <Outlet />
        <ScrollRestoration getKey={recoveryScrollKey} />
      </>
    ),
    children: [
      {
        path: "/app/recoveries",
        element: <ListFixture />,
        loader: ({ request }) => ({
          merchantUi,
          embed,
          filters: filters(request),
          today: "2026-09-20",
          presets: {
            today: "2026-09-20",
            week: "2026-09-14",
            month: "2026-09-01",
          },
          page: { items: rows, previousCursor: null, nextCursor: null },
          state: "ready",
          error: null,
        }),
      },
      {
        path: "/app/recoveries/:recoveryId",
        element: <DetailFixture />,
        loader: ({ request, params }) => {
          const id = params.recoveryId!;
          const no = id === "empty";
          return {
            merchantUi,
            embed,
            filters: filters(request),
            state: id === "missing" ? "unavailable" : "ready",
            detail:
              id === "missing"
                ? null
                : {
                    id,
                    customer: {
                      firstName: "Ada",
                      lastName: "Lovelace",
                      email: "ada@example.test",
                    },
                    status: "ENGAGED",
                    value: {
                      amount: "134.50",
                      currency: "GBP",
                      incomplete: false,
                    },
                    hasConversation: !no,
                    milestones: {
                      detectedAt: "2026-09-19T23:30:00.000Z",
                      messageSentAt: "2026-09-19T23:31:00.000Z",
                      engagedAt: "2026-09-19T23:33:00.000Z",
                      completedAt: null,
                      expiredAt: null,
                    },
                  },
            messages: {
              state: "ready",
              page: no
                ? { items: [], nextCursor: null, previousCursor: null }
                : messagePage(),
            },
            related: { state: "ready", page: relatedPage(id) },
          };
        },
      },
      ...(["messages", "related"] as const).map((kind) => ({
        path: `/app/recoveries/:recoveryId/${kind}`,
        loader: async ({
          request,
          params,
        }: {
          request: Request;
          params: Record<string, string | undefined>;
        }) => {
          await new Promise((r) => setTimeout(r, 350));
          if (params.recoveryId === "error" && kind === "messages" && !failed) {
            failed = true;
            return { state: "error", page: null };
          }
          return {
            state: "ready",
            page:
              kind === "messages"
                ? messagePage(new URL(request.url).searchParams)
                : relatedPage(
                    params.recoveryId!,
                    new URL(request.url).searchParams,
                  ),
          };
        },
      })),
    ],
  },
]);
createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />,
);
