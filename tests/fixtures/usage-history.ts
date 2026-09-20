import type { UsageData } from "../../app/components/dashboard/UsageEvents";
export function usageFixture(): UsageData {
  return {
    merchantUi: {
      locale: "en-GB",
      timeZone: "Europe/London",
      fallbackLocale: "en",
    },
    embed: { shop: "fixture.myshopify.com", host: "aG9zdA==", embedded: "1" },
    history: {
      state: "ready",
      usageView: "past",
      selection: { billId: "period-1" },
      periodCursor: null,
      periodPage: {
        items: [
          {
            id: "period-1",
            status: "CLOSED",
            periodStart: "2026-08-01T00:00:00Z",
            periodEnd: "2026-09-01T00:00:00Z",
          },
        ],
        nextCursor: null,
        previousCursor: null,
      },
      usagePagination: {
        page: 1,
        pageSize: 10,
        total: 2,
        totalQuantity: 3,
        billId: "period-1",
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-09-01T00:00:00Z",
      },
      usageEvents: [
        {
          id: "e1",
          metric: "RECOVERY_CONVERSATION",
          quantity: 2,
          idempotencyKey: "accounting-event-1",
          occurredAt: "2026-08-10T10:00:00Z",
          sourceRecovery: {
            recoveryId: "owned-recovery",
            detectedAt: "2026-08-10T09:00:00Z",
            customerName: "Ada",
          },
        },
        {
          id: "e2",
          metric: "RECOVERY_CONVERSATION",
          quantity: 1,
          idempotencyKey: "accounting-event-2",
          occurredAt: "2026-08-11T10:00:00Z",
          sourceRecovery: null,
        },
      ],
    },
  };
}
