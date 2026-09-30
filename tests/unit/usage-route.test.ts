import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  shop: vi.fn(),
  subscription: vi.fn(),
  settings: vi.fn(),
  period: vi.fn(),
  periods: vi.fn(),
  recoveries: vi.fn(),
  events: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: mocks.auth },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: mocks.shop },
}));
vi.mock("../../app/services/billing/billing.service", () => ({
  billingService: { getSubscription: mocks.subscription },
}));
vi.mock("../../app/db.server", () => ({
  default: {
    shopSettings: { findUnique: mocks.settings },
    billingPeriod: { findFirst: mocks.period, findMany: mocks.periods },
    checkoutRecovery: { findMany: mocks.recoveries },
    usageEvent: {
      findMany: mocks.events,
      count: mocks.count,
      aggregate: mocks.aggregate,
    },
    $queryRaw: mocks.raw,
  },
}));
import { loader } from "../../app/routes/app/usage/route";
import {
  readUsageHistory,
  readUsageSources,
  UsageCursorError,
} from "../../app/services/usage/history.server";
const period = (id = "period-1", day = 20) => ({
  id,
  status: "CLOSED",
  periodStart: new Date(Date.UTC(2026, 8, day)),
  periodEnd: new Date(Date.UTC(2026, 9, day)),
});
const event = (sourceId: string | null) => ({
  id: `event-${sourceId}`,
  metric: "RECOVERY_CONVERSATION",
  quantity: 2,
  idempotencyKey: "accounting-key",
  sourceId,
  sourceType: null,
  occurredAt: new Date("2026-09-20T10:00:00Z"),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    admin: {},
    session: { shop: "merchant.myshopify.com" },
  });
  mocks.shop.mockResolvedValue({ id: "shop-1", status: "ACTIVE" });
  mocks.subscription.mockResolvedValue({ status: "ACTIVE" });
  mocks.settings.mockResolvedValue({ onboardingCompleted: true });
  mocks.period.mockResolvedValue(period());
  mocks.periods.mockResolvedValue([period()]);
  mocks.events.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.aggregate.mockResolvedValue({ _sum: { quantity: null } });
  mocks.raw.mockResolvedValue([]);
});
const request = (query = "") => ({
  request: new Request(`https://example.test/app/usage${query}`),
});
describe("usage route and bounded readers", () => {
  it("keeps onboarding out of usage before any billing-history query", async () => {
    mocks.settings.mockResolvedValue({ onboardingCompleted: false });
    await expect(loader(request("?billId=foreign"))).rejects.toSatisfy(
      (r: Response) =>
        r.headers.get("Location") === "/app?shop=merchant.myshopify.com",
    );
    expect(mocks.period).not.toHaveBeenCalled();
    expect(mocks.events).not.toHaveBeenCalled();
  });
  it.each(["NO_CONTRACT", "FROZEN", "UNMAPPED", "ACTIVE"])(
    "retains history for %s",
    async (status) => {
      mocks.subscription.mockResolvedValue({ status });
      const data = await loader(request());
      expect(data.history?.state).toBe("ready");
      expect(mocks.events).toHaveBeenCalled();
    },
  );
  it("scopes selected-period quantities and bounds event projections without recovery hydration", async () => {
    mocks.events.mockResolvedValue([event(null)]);
    mocks.count.mockResolvedValue(31);
    mocks.aggregate.mockResolvedValue({ _sum: { quantity: 62 } });
    const data = await loader(
      request("?bill=past&billId=period-1&page=2&pageSize=25"),
    );
    expect(mocks.period).toHaveBeenCalledWith({
      where: { shopId: "shop-1", id: "period-1" },
      select: expect.any(Object),
    });
    expect(mocks.periods).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop-1", status: "CLOSED" },
        take: 26,
        orderBy: [{ periodStart: "desc" }, { id: "desc" }],
      }),
    );
    const where = {
      shopId: "shop-1",
      billingPeriodId: "period-1",
      metric: "RECOVERY_CONVERSATION",
    };
    expect(mocks.events).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        take: 25,
        skip: 25,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(mocks.count).toHaveBeenCalledWith({ where });
    expect(mocks.aggregate).toHaveBeenCalledWith({
      where,
      _sum: { quantity: true },
    });
    expect(data.history?.usagePagination.totalQuantity).toBe(62);
    expect(data.history?.usageEvents[0].quantity).toBe(2);
    expect(mocks.recoveries).not.toHaveBeenCalled();
    expect(mocks.periods.mock.calls[0][0]).not.toHaveProperty("include");
    expect(mocks.raw).not.toHaveBeenCalled();
  });
  it.each(["missing", "foreign", "deleted", "", "bad/id"])(
    "never substitutes an explicit unavailable period %s",
    async (id) => {
      mocks.period.mockResolvedValue(null);
      const data = await loader(
        request(`?bill=past&billId=${encodeURIComponent(id)}`),
      );
      expect(data.history?.state).toBe("unavailable");
      expect(data.history?.usagePagination.billId).toBeNull();
      expect(data.history?.selection).toEqual({ billId: "" });
      expect(mocks.events).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate IDs and uses defaults only for absent IDs", async () => {
    expect(
      (
        await readUsageHistory(
          "shop-1",
          new URLSearchParams("billId=a&billId=b"),
        )
      ).state,
    ).toBe("unavailable");
    expect(mocks.period).not.toHaveBeenCalled();
    await readUsageHistory("shop-1", new URLSearchParams("bill=past"));
    expect(mocks.period).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop-1", status: "CLOSED" },
        orderBy: [{ periodStart: "desc" }, { id: "desc" }],
      }),
    );
  });
  it("bounds periods to 25 and traverses ties using original keys without cursor-row lookup", async () => {
    mocks.periods.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => period(`period-${30 - i}`, 20)),
    );
    const first = await readUsageHistory(
      "shop-1",
      new URLSearchParams("bill=past&billId=period-1"),
    );
    expect(first.periodPage.items).toHaveLength(25);
    expect(first.periodPage.nextCursor).toBeTruthy();
    expect(first.periodPage.previousCursor).toBeNull();
    mocks.periods.mockResolvedValue([period("period-4")]);
    const next = await readUsageHistory(
      "shop-1",
      new URLSearchParams({
        bill: "past",
        billId: "period-1",
        periodCursor: first.periodPage.nextCursor!,
      }),
    );
    expect(mocks.periods.mock.lastCall?.[0].where.OR).toEqual([
      { periodStart: { lt: period().periodStart } },
      { periodStart: period().periodStart, id: { lt: "period-6" } },
    ]);
    expect(next.periodPage.previousCursor).toBeTruthy();
    await readUsageHistory(
      "shop-1",
      new URLSearchParams({
        bill: "past",
        periodCursor: next.periodPage.previousCursor!,
      }),
    );
    expect(mocks.periods.mock.lastCall?.[0].orderBy).toEqual([
      { periodStart: "asc" },
      { id: "asc" },
    ]);
  });
  it("rejects cursor reuse across tenant/view and malformed cursors before any query", async () => {
    mocks.periods.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => period(`p-${i}`)),
    );
    const first = await readUsageHistory(
      "shop-1",
      new URLSearchParams("bill=past"),
    );
    vi.clearAllMocks();
    for (const [shop, query] of [
      ["other", `bill=past&periodCursor=${first.periodPage.nextCursor}`],
      ["shop-1", `bill=current&periodCursor=${first.periodPage.nextCursor}`],
      ["shop-1", "periodCursor=garbage"],
    ])
      await expect(
        readUsageHistory(shop, new URLSearchParams(query)),
      ).rejects.toBeInstanceOf(UsageCursorError);
    expect(mocks.period).not.toHaveBeenCalled();
    expect(mocks.periods).not.toHaveBeenCalled();
  });
  it("keeps selected periods outside the selector page independently available", async () => {
    mocks.period.mockResolvedValue(period("old-selected"));
    mocks.periods.mockResolvedValue([period("new")]);
    const data = await readUsageHistory(
      "shop-1",
      new URLSearchParams("bill=past&billId=old-selected"),
    );
    expect(data.usagePagination.billId).toBe("old-selected");
    expect(data.periodPage.items[0].id).toBe("new");
  });
  it("bounds hostile pagination inputs", async () => {
    await readUsageHistory(
      "shop-1",
      new URLSearchParams("pageSize=999999&page=99999999999999"),
    );
    expect(mocks.events).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 0 }),
    );
  });
  it("resolves only current-page recovery/conversation/message IDs in one tenant-constrained batch", async () => {
    mocks.events.mockResolvedValue(
      ["recovery", "conversation", "message", "missing"].map(event),
    );
    mocks.raw.mockResolvedValue(
      ["recovery", "conversation", "message"].map((sourceId) => ({
        sourceId,
        recoveryId: "owned",
        detectedAt: period().periodStart,
        firstName: "Ada",
        lastName: null,
        email: null,
      })),
    );
    const data = await readUsageHistory("shop-1", new URLSearchParams());
    expect(mocks.raw).toHaveBeenCalledTimes(1);
    const sql = mocks.raw.mock.calls[0][0];
    expect(sql.strings.join("")).toContain("UNION ALL");
    expect(sql.strings.join("")).toContain('"shopId" IS NULL');
    expect(sql.strings.join("")).toContain("LIMIT 300");
    expect(sql.values).toContain("shop-1");
    expect(sql.values).toContain("message");
    expect(sql.strings.join("")).not.toContain("content");
    expect(
      data.usageEvents
        .slice(0, 3)
        .every((e) => e.sourceRecovery?.recoveryId === "owned"),
    ).toBe(true);
    expect(data.usageEvents[3].sourceRecovery).toBeNull();
  });
  it("fails closed for ambiguous source IDs", async () => {
    mocks.raw.mockResolvedValue(
      ["a", "b"].map((recoveryId) => ({
        sourceId: "collision",
        recoveryId,
        detectedAt: period().periodStart,
        firstName: null,
        lastName: null,
        email: null,
      })),
    );
    expect((await readUsageSources("shop-1", ["collision"])).size).toBe(0);
  });
  it("provides a safe error state while retaining trusted embed context", async () => {
    mocks.period.mockRejectedValue(new Error("private database failure"));
    const data = await loader(
      request("?shop=attacker&host=aG9zdA==&embedded=1"),
    );
    expect(data).toMatchObject({
      history: null,
      error: "read",
      embed: {
        shop: "merchant.myshopify.com",
        host: "aG9zdA==",
        embedded: "1",
      },
    });
    expect(JSON.stringify(data)).not.toContain("private database");
  });
});
