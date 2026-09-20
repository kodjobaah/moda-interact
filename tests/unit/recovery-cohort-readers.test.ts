import { describe, expect, it, vi } from "vitest";
import { CheckoutRecoveryStatus, Prisma } from "@prisma/client";
import {
  normalizeRecoveryQuery,
  decodeRecoveryCursor,
  encodeRecoveryCursor,
  RecoveryQueryError,
} from "../../app/services/recoveries/recovery-query.server";

const mock = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../../app/db.server", () => ({
  default: { $queryRaw: mock.query, $transaction: mock.transaction },
}));
const { readRecoveryCohortSummary, readRecoveryPage, readRecoveryOverview } =
  await import("../../app/services/recoveries/recovery-readers.server");
const now = new Date("2026-09-20T12:00:00Z");
const normalize = (parameters = "", timeZone = "UTC") =>
  normalizeRecoveryQuery(new URLSearchParams(parameters), { timeZone }, now);
const row = (id: string) => ({
  id,
  status: CheckoutRecoveryStatus.DETECTED,
  totalPrice: "12345678901234567890.123456789",
  currency: "GBP",
  detectedAt: new Date("2026-09-10T12:00:00Z"),
  customerId: "c",
  firstName: " Ada ",
  lastName: "Lovelace",
  email: "ada@example.test",
  checkoutToken: "secret",
  messages: ["private"],
});
function reader(results: unknown[]) {
  const calls: Prisma.Sql[] = [];
  return {
    calls,
    db: {
      $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
        calls.push(sql);
        return results.shift();
      }),
    } as unknown as Pick<Prisma.TransactionClient, "$queryRaw">,
  };
}

describe("cohort date/filter normalization", () => {
  it("defaults to 30 inclusive merchant dates and uses the existing UTC fallback", () => {
    expect(normalize()).toMatchObject({
      from: "2026-08-22",
      to: "2026-09-20",
      start: "2026-08-22T00:00:00.000Z",
      end: "2026-09-21T00:00:00.000Z",
      pageSize: 25,
    });
    expect(normalize("", "bad/zone").timeZone).toBe("UTC");
    expect(
      normalizeRecoveryQuery(
        new URLSearchParams(),
        { timeZone: "America/Los_Angeles" },
        new Date("2026-09-20T01:00:00Z"),
      ).to,
    ).toBe("2026-09-19");
  });
  it.each([
    [
      "2026-03-29",
      "Europe/London",
      "2026-03-29T00:00:00.000Z",
      "2026-03-29T23:00:00.000Z",
    ],
    [
      "2025-10-26",
      "Europe/London",
      "2025-10-25T23:00:00.000Z",
      "2025-10-27T00:00:00.000Z",
    ],
    [
      "2026-04-05",
      "Australia/Lord_Howe",
      "2026-04-04T13:00:00.000Z",
      "2026-04-05T13:30:00.000Z",
    ],
    [
      "2018-11-04",
      "America/Sao_Paulo",
      "2018-11-04T03:00:00.000Z",
      "2018-11-05T02:00:00.000Z",
    ],
    [
      "2011-12-30",
      "Pacific/Apia",
      "2011-12-30T10:00:00.000Z",
      "2011-12-30T10:00:00.000Z",
    ],
  ])("uses calendar boundaries for %s in %s", (date, zone, start, end) => {
    expect(normalize(`from=${date}&to=${date}`, zone)).toMatchObject({
      start,
      end,
    });
  });
  it.each([
    ["from=2026-02-30", "invalid_date"],
    ["from=2026-9-01", "invalid_date"],
    ["from=2026-09-20&to=2026-09-19", "reversed_range"],
    ["to=2026-09-21", "future_date"],
    ["from=2025-09-19", "range_too_long"],
    ["status=DETECTED", "invalid_filter"],
    ["pageSize=51", "invalid_page_size"],
    ["pageSize=-1", "invalid_page_size"],
    ["pageSize=1.5", "invalid_page_size"],
    [`q=${"a".repeat(101)}`, "invalid_search"],
    ["q=%00", "invalid_search"],
    ["cursor=", "invalid_cursor"],
  ])("rejects %s with a localizable error code", (parameters, code) => {
    expect(() => normalize(parameters)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
  it("allows exactly 366 dates and trims search", () => {
    expect(normalize("from=2025-09-20&q=%20Ada%20&pageSize=50")).toMatchObject({
      q: "Ada",
      pageSize: 50,
    });
  });
});

describe("tenant-bound bounded reads", () => {
  it("aggregates only the date cohort and retains decimal strings and unknown counts", async () => {
    const { db, calls } = reader([
      [
        {
          status: "COMPLETED",
          currency: "GBP",
          count: 2n,
          knownCount: 2n,
          totalPrice: "12345678901234567890.123456789",
        },
        {
          status: "COMPLETED",
          currency: "USD",
          count: 1n,
          knownCount: 1n,
          totalPrice: "0.30",
        },
        {
          status: "COMPLETED",
          currency: null,
          count: 3n,
          knownCount: 0n,
          totalPrice: null,
        },
        {
          status: "ENGAGED",
          currency: null,
          count: 2n,
          knownCount: 0n,
          totalPrice: null,
        },
      ],
    ]);
    const summary = await readRecoveryCohortSummary(
      "shop-a",
      normalize("status=EXPIRED&q=never-matches"),
      db,
    );
    expect(summary).toMatchObject({
      started: 8,
      recovered: 6,
      ongoing: 2,
      recoveryRate: 0.75,
      unknownValueCount: 3,
      recoveredValues: [
        {
          currency: "GBP",
          totalPrice: "12345678901234567890.123456789",
          count: 2,
        },
        { currency: "USD", totalPrice: "0.30", count: 1 },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('GROUP BY r."status"');
    expect(calls[0].values).not.toContain("EXPIRED");
    expect(calls[0].values).not.toContain("never-matches");
    const empty = await readRecoveryCohortSummary(
      "shop-a",
      normalize(),
      reader([[]]).db,
    );
    expect(empty).toMatchObject({
      started: 0,
      recoveryRate: null,
      recoveredValues: [],
    });
  });
  it("reports unknown-only completed values without substituting zero", async () => {
    const summary = await readRecoveryCohortSummary(
      "shop-a",
      normalize(),
      reader([
        [
          {
            status: "COMPLETED",
            currency: null,
            count: 2n,
            knownCount: 0n,
            totalPrice: null,
          },
        ],
      ]).db,
    );
    expect(summary).toMatchObject({
      started: 2,
      recovered: 2,
      recoveryRate: 1,
      recoveredValues: [],
      unknownValueCount: 2,
    });
  });
  it("uses safe projection, scoped join, literal wildcard search and a maximum 51-row query", async () => {
    const { db, calls } = reader([[row("r1")]]);
    const result = await readRecoveryPage(
      "shop-a",
      normalize("q=%25_%21%27%5C&status=ongoing&pageSize=50"),
      db,
    );
    expect(calls[0].values).toContain("%!%!_!!'\\%");
    expect(calls[0].values.at(-1)).toBe(51);
    expect(calls[0].values).toContain("shop-a");
    expect(calls[0].text).toContain('c."shopId" = r."shopId"');
    expect(calls[0].text).toContain('r."detectedAt" <');
    expect(calls[0].text).not.toMatch(
      /OFFSET|checkoutToken|checkoutUrl|lineItems|messages|billableActions/,
    );
    expect(result.items[0]).toEqual({
      id: "r1",
      customer: { displayName: "Ada Lovelace", email: "ada@example.test" },
      status: "DETECTED",
      totalPrice: "12345678901234567890.123456789",
      currency: "GBP",
      detectedAt: "2026-09-10T12:00:00.000Z",
      displayLabel: {
        kind: "checkout",
        detectedAt: "2026-09-10T12:00:00.000Z",
      },
    });
  });
  it("supports tied-key next/previous traversal using original keys without row lookup", async () => {
    const query = normalize("pageSize=2");
    const first = await readRecoveryPage(
      "shop-a",
      query,
      reader([[row("r4"), row("r3"), row("r2")]]).db,
    );
    expect(first.previousCursor).toBeNull();
    const secondQuery = normalize(`pageSize=2&cursor=${first.nextCursor}`);
    expect(decodeRecoveryCursor(secondQuery, "shop-a")).toMatchObject({
      id: "r3",
      direction: "next",
    });
    const next = reader([[row("r2"), row("r1")]]);
    const second = await readRecoveryPage("shop-a", secondQuery, next.db);
    expect(next.calls[0].text).toContain('(r."detectedAt", r."id") <');
    expect(next.calls[0].values).toContain("r3");
    expect(second.nextCursor).toBeNull();
    const previous = reader([[row("r3"), row("r4")]]);
    const back = await readRecoveryPage(
      "shop-a",
      normalize(`pageSize=2&cursor=${second.previousCursor}`),
      previous.db,
    );
    expect(previous.calls[0].text).toContain('(r."detectedAt", r."id") >');
    expect(previous.calls[0].text).toContain('r."detectedAt" ASC, r."id" ASC');
    expect(back.items.map((item) => item.id)).toEqual(["r4", "r3"]);
    expect(back.previousCursor).toBeNull();
    const empty = await readRecoveryPage(
      "shop-a",
      secondQuery,
      reader([[]]).db,
    );
    expect(
      decodeRecoveryCursor(
        normalize(`pageSize=2&cursor=${empty.previousCursor}`),
        "shop-a",
      )?.direction,
    ).toBe("previous");
  });
  it("rejects cursor replay across shops, filters, dates, zones and sizes before querying", async () => {
    const cursor = encodeRecoveryCursor(normalize(), "shop-a", {
      direction: "next",
      detectedAt: "2026-09-10T12:00:00.000Z",
      id: "deleted-row",
    });
    for (const [shop, parameters, zone] of [
      ["shop-b", "", "UTC"],
      ["shop-a", "q=a&", "UTC"],
      ["shop-a", "status=COMPLETED&", "UTC"],
      ["shop-a", "from=2026-09-01&", "UTC"],
      ["shop-a", "pageSize=50&", "UTC"],
      ["shop-a", "", "Europe/London"],
    ]) {
      const { db, calls } = reader([]);
      await expect(
        readRecoveryPage(
          shop,
          normalize(`${parameters}cursor=${cursor}`, zone),
          db,
        ),
      ).rejects.toBeInstanceOf(RecoveryQueryError);
      expect(calls).toHaveLength(0);
    }
  });
  it("rejects malformed, oversized and out-of-cohort cursors", async () => {
    const query = normalize();
    for (const cursor of [
      "e30",
      Buffer.from("[1]").toString("base64url"),
      encodeRecoveryCursor(query, "shop-a", {
        direction: "next",
        detectedAt: "2020-01-01T00:00:00.000Z",
        id: "r",
      }),
    ]) {
      await expect(
        readRecoveryPage(
          "shop-a",
          normalize(`cursor=${cursor}`),
          reader([]).db,
        ),
      ).rejects.toBeInstanceOf(RecoveryQueryError);
    }
    expect(() => normalize(`cursor=${"a".repeat(1025)}`)).toThrow(
      RecoveryQueryError,
    );
  });
  it("reads the five-row overview and summary in repeatable read, without list filters", async () => {
    mock.query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => row(`r${i}`)));
    mock.transaction.mockImplementation(
      async (callback: (db: unknown) => unknown) =>
        callback({ $queryRaw: mock.query }),
    );
    const result = await readRecoveryOverview(
      "shop-a",
      normalize("q=nobody&status=CANCELLED"),
    );
    expect(mock.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    expect(result.preview).toHaveLength(5);
    expect(mock.query).toHaveBeenCalledTimes(2);
    const sql = mock.query.mock.calls[1][0] as Prisma.Sql;
    expect(sql.values.at(-1)).toBe(6);
    expect(sql.values).not.toContain("CANCELLED");
    expect(sql.text).not.toContain("ILIKE");
  });
});

// Opt-in bounded local SQL fixture: no containers, real commerce data, or persistent writes.
// RECOVERY_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/moda_interact npm test -- tests/unit/recovery-cohort-readers.test.ts
it.skipIf(!process.env.RECOVERY_TEST_DATABASE_URL)(
  "validates actual PostgreSQL aggregates, search, keysets and plans",
  async () => {
    const url = new URL(process.env.RECOVERY_TEST_DATABASE_URL!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/moda_interact"
    )
      throw new Error(
        "Only the standard local moda_interact fixture database is allowed",
      );
    const { Client, types } = await import("pg");
    const client = new Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 3000,
      types: {
        getTypeParser: (oid: number) =>
          oid === 1114
            ? (value: string) => new Date(`${value}Z`)
            : types.getTypeParser(oid),
      },
    });
    await client.connect();
    const schema = `recovery_fixture_${process.pid}`;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(
        `CREATE TYPE "${schema}"."CheckoutRecoveryStatus" AS ENUM ('DETECTED','MESSAGE_SENT','ENGAGED','COMPLETED','EXPIRED','CANCELLED')`,
      );
      await client.query(
        `CREATE TABLE "${schema}"."Customer" (id text PRIMARY KEY, "shopId" text, "firstName" text, "lastName" text, email text)`,
      );
      await client.query(
        `CREATE TABLE "${schema}"."CheckoutRecovery" (id text PRIMARY KEY, "shopId" text, "customerId" text, status "${schema}"."CheckoutRecoveryStatus", "detectedAt" timestamp(3), "totalPrice" numeric, currency text)`,
      );
      await client.query(
        `CREATE INDEX ON "${schema}"."CheckoutRecovery" ("shopId", "detectedAt", id)`,
      );
      await client.query(
        `CREATE INDEX ON "${schema}"."CheckoutRecovery" ("shopId", status, "detectedAt", id)`,
      );
      await client.query(
        `INSERT INTO "${schema}"."Customer" VALUES ('c1','shop-a','Ada','Lovelace','ada@example.test'),('c2','shop-b','Foreign','Secret','private@example.test'),('c3','shop-a','Literal','%_!','literal@example.test')`,
      );
      const fixtures = [
        [
          "r9",
          "shop-a",
          "c1",
          "COMPLETED",
          "2026-09-10T12:00:00Z",
          "0.1",
          "GBP",
        ],
        [
          "r8",
          "shop-a",
          "c1",
          "COMPLETED",
          "2026-09-10T12:00:00Z",
          "0.2",
          "GBP",
        ],
        [
          "r7",
          "shop-a",
          "c1",
          "COMPLETED",
          "2026-09-10T12:00:00Z",
          "12345678901234567890.123456789",
          "USD",
        ],
        [
          "r6",
          "shop-a",
          null,
          "COMPLETED",
          "2026-09-10T12:00:00Z",
          null,
          "GBP",
        ],
        ["r5", "shop-a", null, "COMPLETED", "2026-09-10T12:00:00Z", "4", null],
        ["r4", "shop-a", "c2", "DETECTED", "2026-09-10T12:00:00Z", "5", "GBP"],
        ["r3", "shop-a", "c3", "ENGAGED", "2026-09-10T12:00:00Z", "5", "GBP"],
        ["r2", "shop-a", null, "EXPIRED", "2026-08-22T00:00:00Z", "5", "GBP"],
        [
          "r1",
          "shop-a",
          null,
          "CANCELLED",
          "2026-08-21T23:59:59.999Z",
          "5",
          "GBP",
        ],
        [
          "end",
          "shop-a",
          null,
          "COMPLETED",
          "2026-09-21T00:00:00Z",
          "99",
          "GBP",
        ],
        [
          "foreign",
          "shop-b",
          "c2",
          "COMPLETED",
          "2026-09-10T12:00:00Z",
          "99",
          "GBP",
        ],
      ];
      for (const values of fixtures)
        await client.query(
          `INSERT INTO "${schema}"."CheckoutRecovery" VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          values,
        );
      const sqls: Prisma.Sql[] = [];
      const db = {
        $queryRaw: async (sql: Prisma.Sql) => {
          sqls.push(sql);
          const result = await client.query(
            sql.text.replaceAll("commerce.", `"${schema}".`),
            sql.values.map((value) =>
              value instanceof Date ? value.toISOString() : value,
            ),
          );
          return result.rows.map((row) => ({
            ...row,
            ...(row.count !== undefined
              ? { count: BigInt(row.count), knownCount: BigInt(row.knownCount) }
              : {}),
          }));
        },
      } as unknown as Pick<Prisma.TransactionClient, "$queryRaw">;
      const summary = await readRecoveryCohortSummary(
        "shop-a",
        normalize("q=missing&status=CANCELLED"),
        db,
      );
      expect(summary).toMatchObject({
        started: 8,
        recovered: 5,
        recoveryRate: 5 / 8,
        ongoing: 2,
        unknownValueCount: 2,
        recoveredValues: [
          { currency: "GBP", totalPrice: "0.3", count: 2 },
          {
            currency: "USD",
            totalPrice: "12345678901234567890.123456789",
            count: 1,
          },
        ],
      });
      const first = await readRecoveryPage(
        "shop-a",
        normalize("pageSize=2"),
        db,
      );
      expect(first.items.map((row) => row.id)).toEqual(["r9", "r8"]);
      // Cursor row removal must not require a lookup or lose subsequent ties.
      await client.query(
        `DELETE FROM "${schema}"."CheckoutRecovery" WHERE id='r8'`,
      );
      const second = await readRecoveryPage(
        "shop-a",
        normalize(`pageSize=2&cursor=${first.nextCursor}`),
        db,
      );
      expect(second.items.map((row) => row.id)).toEqual(["r7", "r6"]);
      const back = await readRecoveryPage(
        "shop-a",
        normalize(`pageSize=2&cursor=${second.previousCursor}`),
        db,
      );
      expect(back.items.map((row) => row.id)).toEqual(["r9"]);
      expect(
        (
          await readRecoveryPage("shop-a", normalize("q=ADA%20lovelace"), db)
        ).items.map((row) => row.id),
      ).toEqual(["r9", "r7"]);
      expect(
        (
          await readRecoveryPage("shop-a", normalize("q=%25_%21"), db)
        ).items.map((row) => row.id),
      ).toEqual(["r3"]);
      expect(
        (await readRecoveryPage("shop-a", normalize("q=secret"), db)).items,
      ).toEqual([]);
      const ongoing = await readRecoveryPage(
        "shop-a",
        normalize("status=ongoing"),
        db,
      );
      expect(ongoing.items.map((row) => row.id)).toEqual(["r4", "r3"]);
      expect(ongoing.items[0].customer).toBeNull();
      const completed = await readRecoveryPage(
        "shop-a",
        normalize("status=COMPLETED"),
        db,
      );
      expect(completed.items.map((row) => row.id)).toEqual([
        "r9",
        "r7",
        "r6",
        "r5",
      ]);
      const plans = [];
      for (const sql of [sqls[0], sqls[1], sqls[2], sqls[4]]) {
        const plan = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql.text.replaceAll("commerce.", `"${schema}".`)}`,
          sql.values.map((value) =>
            value instanceof Date ? value.toISOString() : value,
          ),
        );
        plans.push({ sql: sql.text, parameters: sql.values, plan: plan.rows });
      }
      if (process.env.RECOVERY_TEST_PLAN_OUTPUT) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
          process.env.RECOVERY_TEST_PLAN_OUTPUT,
          JSON.stringify(plans, null, 2) + "\n",
        );
      }
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
  15000,
);
