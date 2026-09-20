import type { OverviewProps } from "../../app/components/dashboard/RecoveryOverview";
export function overviewFixture(): OverviewProps {
  return {
    merchantUi: { locale: "en-GB", timeZone: "Europe/London" },
    merchantExperienceState: "ACTIVE",
    subscription: { status: "ACTIVE" },
    pricingCatalogue: [],
    capacity: null,
    pendingRecoveries: {
      available: true,
      page: 1,
      total: 0,
      totalPages: 0,
      items: [],
    },
    onRefresh() {},
    performance: {
      state: "ready",
      today: "2026-09-20",
      presets: { today: "2026-09-20", week: "2026-09-14", month: "2026-08-22" },
      filters: {
        from: "2026-09-01",
        to: "2026-09-20",
        status: "all",
        q: "",
        pageSize: 25,
        cursor: null,
      },
      embed: { shop: "fixture.myshopify.com", host: "aG9zdA==", embedded: "1" },
      overview: {
        summary: {
          started: 10,
          recovered: 3,
          ongoing: 2,
          recoveryRate: 0.3,
          statuses: {
            DETECTED: 0,
            MESSAGE_SENT: 1,
            ENGAGED: 1,
            COMPLETED: 3,
            EXPIRED: 3,
            CANCELLED: 2,
          },
          recoveredValues: [
            { currency: "GBP", totalPrice: "25.10", count: 1 },
            { currency: "EUR", totalPrice: "40.20", count: 1 },
          ],
          unknownValueCount: 1,
        },
        preview: [
          {
            id: "basket-1",
            customer: { displayName: "Ada", email: null },
            status: "COMPLETED",
            detectedAt: "2026-09-19T10:00:00Z",
            totalPrice: "25.10",
            currency: "GBP",
            displayLabel: {
              kind: "checkout",
              detectedAt: "2026-09-19T10:00:00Z",
            },
          },
        ],
      },
    },
  };
}
