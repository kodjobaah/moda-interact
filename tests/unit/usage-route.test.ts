import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  shop: vi.fn(),
  subscription: vi.fn(),
  period: vi.fn(),
  periods: vi.fn(),
  recoveries: vi.fn(),
  events: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
  raw: vi.fn(), records: [] as unknown[], brokenSink: false,
}));
vi.mock("../../app/services/shop/merchant-request-context.server", () => ({
  getMerchantRequestContext: async ({ request }: { request: Request }) => ({
    authentication: await mocks.auth(request), shop: await mocks.shop(), readSubscription: () => mocks.subscription(),
  }),
}));
vi.mock("@modainteract/moda-interact-shared/logging", async importOriginal => {
  const actual = await importOriginal<typeof import("@modainteract/moda-interact-shared/logging")>();
  return { ...actual, createLogger: (options: Parameters<typeof actual.createLogger>[0]) => actual.createLogger({ ...options,
    sink: record => { if (mocks.brokenSink) throw new Error("sink unavailable"); mocks.records.push(JSON.parse(JSON.stringify(record))); },
  }) };
});
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
  vi.clearAllMocks(); mocks.records.length = 0; mocks.brokenSink = false;
  mocks.auth.mockResolvedValue({
    admin: {},
    session: { shop: "merchant.myshopify.com" },
  });
  mocks.shop.mockResolvedValue({
    id: "shop-1",
    status: "ACTIVE",
    onboardingCompleted: true,
    defaultTimeZone: "UTC",
  });
  mocks.subscription.mockResolvedValue({ status: "ACTIVE" });
  mocks.period.mockResolvedValue(period());
  mocks.periods.mockResolvedValue([period()]);
  mocks.events.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { quantity: null } });
  mocks.raw.mockResolvedValue([]);
  // Unified reader has a single result row even for an empty page.
  mocks.raw.mockImplementation(async (sql) => sql.strings.join("").includes("WITH classified")
    ? [{ id: null, total: 0n, totalQuantity: 0 }] : []);

});
const request = (query = "") => ({
  request: new Request(`https://example.test/app/usage${query}`),
});
describe("usage route and bounded readers", () => {
  it("keeps onboarding out of usage before any billing-history query", async () => {
    mocks.shop.mockResolvedValue({
      id: "shop-1",
      status: "ACTIVE",
      onboardingCompleted: false,
      defaultTimeZone: "UTC",
    });
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
      expect(data.history?.usageView).toBe("all");
      expect(mocks.raw).toHaveBeenCalledOnce();
      expect(mocks.period).not.toHaveBeenCalled();
    },
  );
  it("scopes selected-period quantities and bounds event projections without recovery hydration", async () => {
    mocks.events.mockResolvedValue([event(null)]);
    mocks.count.mockResolvedValue(31);
    mocks.aggregate.mockResolvedValue({ _count: { _all: 31 }, _sum: { quantity: 62 } });
    const history = await readUsageHistory("shop-1",
      new URLSearchParams("bill=past&billId=period-1&page=2&pageSize=25"));
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
    const owner = { shopId: "shop-1", provider: "SHOPIFY", metric: "RECOVERY_CONVERSATION" };
    const original = {
      correctionOfUsageEventId: null,
      OR: [
        { billingPeriodId: "period-1" },
        { billingPeriodId: null, sourceType: { in: ["PURCHASED_RECOVERY_CREDITS", "PROMOTIONAL_RECOVERY_CREDITS"] },
          occurredAt: { gte: period().periodStart, lt: period().periodEnd } },
      ],
    };
    const where = {
      ...owner,
      OR: [original, { correctionOfUsageEvent: { is: { ...owner, ...original } } }],
    };
    expect(mocks.events).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        take: 25,
        skip: 25,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.aggregate).toHaveBeenCalledWith({
      where,
      _count: { _all: true },
      _sum: { quantity: true },
    });
    expect(history.usagePagination.totalQuantity).toBe(62);
    expect(history.usageEvents[0].quantity).toBe(2);
    expect(mocks.recoveries).not.toHaveBeenCalled();
    expect(mocks.periods.mock.calls[0][0]).not.toHaveProperty("include");
    expect(mocks.raw).toHaveBeenCalledOnce();
  });
  it("preserves signed debit and correction rows without deriving totals from physical outreach or page size", async () => {
    mocks.events.mockResolvedValue([
      { ...event(null), id: "retry-debit", quantity: 1 },
      { ...event(null), id: "failure-correction", quantity: -1 },
    ]);
    mocks.aggregate.mockResolvedValue({ _count: { _all: 3 }, _sum: { quantity: 1 } });
    const data = await readUsageHistory("shop-1", new URLSearchParams("bill=past"));
    expect(data.usageEvents.map(row => [row.id, row.quantity])).toEqual([
      ["retry-debit", 1], ["failure-correction", -1],
    ]);
    expect(data.usagePagination).toMatchObject({ total: 3, totalQuantity: 1 });
    expect(mocks.events.mock.calls[0][0].where).toEqual(mocks.aggregate.mock.calls[0][0].where);
    expect(mocks.raw).toHaveBeenCalledOnce();
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
  it("resolves current-page recovery/conversation/message and reservation links in one tenant-constrained batch", async () => {
    mocks.events.mockResolvedValue(
      ["recovery", "conversation", "message", "missing"].map(event),
    );
    mocks.raw.mockResolvedValue(
      ["recovery", "conversation", "message"].map((sourceId) => ({
        eventId: `event-${sourceId}`,
        logicalKey: null, logicalIdentity: null,
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
    expect(sql.strings.join("")).toContain("LIMIT 401");
    expect(sql.strings.join("")).toContain('"UsageReservation"');
    expect(sql.strings.join("")).toContain('"correctionOfUsageEventId"');
    expect(sql.strings.join("")).toContain('"RecoveryOutreachAttempt"');
    expect(sql.values).toContain("shop-1");
    expect(sql.values).toContain("event-message");
    expect(sql.values).not.toContain("message");
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
        eventId: "collision",
        logicalKey: null, logicalIdentity: null,
        recoveryId,
        detectedAt: period().periodStart,
        firstName: null,
        lastName: null,
        email: null,
      })),
    );
    expect((await readUsageSources("shop-1", ["collision"])).size).toBe(0);
  });
  it("resolves a correction through its own event ID even when its sourceId is null", async () => {
    mocks.events.mockResolvedValue([{ ...event(null), id: "late-correction", quantity: -1,
      correctionOfUsageEventId: "original-debit" }]);
    mocks.raw.mockResolvedValue([{ eventId: "late-correction", recoveryId: "owned",
      logicalKey: null, logicalIdentity: null,
      detectedAt: period().periodStart, firstName: null, lastName: null, email: null }]);
    const data = await readUsageHistory("shop-1", new URLSearchParams());
    expect(data.usageEvents[0].sourceRecovery?.recoveryId).toBe("owned");
    expect(mocks.raw).toHaveBeenCalledOnce();
    const sql = mocks.raw.mock.calls[0][0];
    expect(sql.values).toContain("late-correction");
    expect(sql.values).not.toContain("original-debit");
  });
  it("accepts a canonical retry reservation link and refuses a noncanonical candidate", async () => {
    const common = { recoveryId: "owned", detectedAt: period().periodStart,
      firstName: null, lastName: null, email: null, logicalIdentity: "recovery-outreach:retry_intent" };
    mocks.raw.mockResolvedValue([
      { ...common, eventId: "valid", logicalKey: "recovery:shop-1:recovery-outreach:retry_intent" },
      { ...common, eventId: "invalid", logicalKey: "recovery:other:recovery-outreach:retry_intent" },
    ]);
    const links = await readUsageSources("shop-1", ["valid", "invalid"]);
    expect(links.get("valid")?.recoveryId).toBe("owned");
    expect(links.has("invalid")).toBe(false);
  });
  it("does not prefer a reservation link over a contradictory direct recovery link", async () => {
    const common = { eventId: "retry-debit", detectedAt: period().periodStart,
      firstName: null, lastName: null, email: null };
    mocks.raw.mockResolvedValue([
      { ...common, recoveryId: "canonical", logicalKey: "recovery:shop-1:recovery-outreach:retry_intent",
        logicalIdentity: "recovery-outreach:retry_intent" },
      { ...common, recoveryId: "different", logicalKey: null, logicalIdentity: null },
    ]);
    expect((await readUsageSources("shop-1", ["retry-debit"])).size).toBe(0);
  });
  it("rejects an oversized source page or inconsistent result instead of returning partial links", async () => {
    await expect(readUsageSources("shop-1", Array.from({ length: 101 }, (_, i) => `event-${i}`)))
      .rejects.toThrow("Usage page exceeds source limit");
    expect(mocks.raw).not.toHaveBeenCalled();
    mocks.raw.mockResolvedValue(Array.from({ length: 401 }, () => ({ eventId: "overflow" })));
    await expect(readUsageSources("shop-1", ["overflow"]))
      .rejects.toThrow("Usage source result exceeds page limit");
  });
  it("provides a safe error state while retaining trusted embed context", async () => {
    mocks.period.mockRejectedValue(new Error("private database failure"));
    const data = await loader(
      request("?bill=current&shop=attacker&host=aG9zdA==&embedded=1"),
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


describe("usage read diagnostic ownership", () => {
  it.each([["data", false], ["data", true], ["source", false], ["source", true]] as const)("retains the safe %s read fallback and original error, broken sink=%s", async (stage, broken) => {
    mocks.brokenSink = broken;
    const failure = Object.assign(new Error("usage original marker email=person@example.test", { cause: new Error("source cause https://files.example.test/path?signature=secret-sentinel") }), { code: "P2010" });
    if (stage === "source") {
      mocks.raw.mockResolvedValueOnce([{ id: "event-1", metric: "RECOVERY_CONVERSATION", quantity: 1,
        occurredAt: period().periodStart, sourceId: null, correctionOfUsageEventId: null,
        billingPeriodId: null, chargedAgainst: "LIFETIME_FREE_CREDITS", total: 1n, totalQuantity: 1 }]);
      mocks.raw.mockRejectedValueOnce(failure);
    } else mocks.raw.mockRejectedValueOnce(failure);
    const result = await loader(request());
    expect(result).toMatchObject({ history: null, error: "read" });
    expect(JSON.stringify(result)).not.toContain("usage original marker");
    if (!broken) {
      expect(mocks.records).toHaveLength(1);
      for (const marker of ["usage original marker", "source cause", "P2010", "shop-1"]) expect(JSON.stringify(mocks.records)).toContain(marker);
      for (const secret of ["person@example.test", "secret-sentinel"]) expect(JSON.stringify(mocks.records)).not.toContain(secret);
    }
  });
  it("treats invalid cursors as normal control flow with no fabricated operational diagnostic", async () => {
    expect(await loader(request("?periodCursor=invalid"))).toMatchObject({ error: "cursor", history: null });
    expect(mocks.records).toHaveLength(0);
    expect(mocks.period).not.toHaveBeenCalled();
  });
});

describe("unified usage history", () => {
  it("defaults to one all-time ledger, and preserves signed corrections and exact funding", async () => {
    const row = { metric: "RECOVERY_CONVERSATION", occurredAt: period().periodStart,
      sourceId: null, correctionOfUsageEventId: null, billingPeriodId: null,
      chargedAgainst: "PROMOTIONAL_CREDITS", total: 12n, totalQuantity: 3 };
    mocks.raw.mockResolvedValueOnce([{ ...row, id: "credit", quantity: 1 },
      { ...row, id: "restore", quantity: -1, correctionOfUsageEventId: "credit" }]).mockResolvedValueOnce([]);
    const result = await loader(request("?chargeSource=PROMOTIONAL_CREDITS&page=2"));
    expect(result.history).toMatchObject({ usageView: "all", chargeSource: "PROMOTIONAL_CREDITS",
      usagePagination: { page: 2, billId: null, total: 12, totalQuantity: 3 } });
    expect(result.history?.usageEvents.map(row => [row.quantity, row.chargedAgainst]))
      .toEqual([[1, "PROMOTIONAL_CREDITS"], [-1, "PROMOTIONAL_CREDITS"]]);
    expect(mocks.period).not.toHaveBeenCalled();
    const sql = mocks.raw.mock.calls[0][0];
    expect(sql.values).toContain("PROMOTIONAL_CREDITS");
    expect(sql.values).toContain("SHOPIFY");
    expect(sql.strings.join("")).toContain('SELECT * FROM classified');
    expect(mocks.raw).toHaveBeenCalledTimes(2);
  });
  it("keeps current/past filters and refuses a mismatched all-time period or invalid source", async () => {
    for (const query of ["?bill=all&billId=period-1", "?chargeSource=unknown",
      "?chargeSource=ALL&chargeSource=PURCHASED_TOP_UP"]) {
      expect(await loader(request(query))).toMatchObject({ history: null, error: "cursor" });
    }
    expect(mocks.raw).not.toHaveBeenCalled();
    await loader(request("?bill=past&billId=period-1&chargeSource=INCLUDED_PLAN_ALLOWANCE"));
    expect(mocks.period).toHaveBeenCalledWith({
      where: { shopId: "shop-1", id: "period-1", status: "CLOSED" }, select: expect.any(Object),
    });
    expect(mocks.raw.mock.calls[0][0].values).toContain("period-1");
  });
});
