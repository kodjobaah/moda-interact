import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { readFileSync } from "node:fs";
import {
  normalizeRecoveryQuery,
  encodeRecoveryCursor,
} from "../../app/services/recoveries/recovery-query.server";
import { recoveryListUrl } from "../../app/routes/app/recoveries/recovery-list-state";
import RecoveryList from "../../app/routes/app/recoveries/RecoveryList";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  shop: vi.fn(),
  settings: vi.fn(),
  subscription: vi.fn(),
  page: vi.fn(),
  exists: vi.fn(),
}));
vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticate },
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
    checkoutRecovery: { findFirst: mocks.exists },
  },
}));
vi.mock("../../app/services/recoveries/recovery-readers.server", () => ({
  readRecoveryPage: mocks.page,
}));
const { loadRecoveryList } =
  await import("../../app/routes/app/recoveries/loader.server");
const request = (search = "") =>
  ({
    request: new Request(`https://app.example/app/recoveries?${search}`),
  }) as LoaderFunctionArgs;
const row = {
  id: "opaque-private-id",
  status: "COMPLETED",
  detectedAt: "2026-09-10T12:00:00.000Z",
  totalPrice: "100.25",
  currency: "GBP",
  customer: { displayName: "Ada Lovelace", email: "ada@example.test" },
  displayLabel: { kind: "checkout", detectedAt: "2026-09-10T12:00:00.000Z" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
  mocks.authenticate.mockResolvedValue({
    admin: {},
    session: { shop: "owned.myshopify.com", locale: "en-GB" },
  });
  mocks.shop.mockResolvedValue({ id: "owned-shop", status: "ACTIVE" });
  mocks.settings.mockResolvedValue({
    onboardingCompleted: true,
    defaultTimeZone: "Europe/London",
  });
  mocks.subscription.mockResolvedValue({ status: "ACTIVE" });
  mocks.page.mockResolvedValue({
    items: [row],
    previousCursor: null,
    nextCursor: "next-boundary",
  });
  mocks.exists.mockResolvedValue({ id: "exists" });
});

describe("independent recovery list loader", () => {
  it.each(["ACTIVE", "NO_CONTRACT", "FROZEN", "BILLING_ATTENTION"])(
    "allows %s and uses the authenticated shop, never URL ownership",
    async (status) => {
      mocks.subscription.mockResolvedValue({ status });
      const result = await loadRecoveryList(
        request(
          "shopId=foreign&shop=foreign.myshopify.com&host=YWJj&embedded=1&id_token=secret&returnTo=https://evil.test&q=%20Ada%20",
        ),
      );
      expect(result.state).toBe("ready");
      expect(mocks.page).toHaveBeenCalledWith(
        "owned-shop",
        expect.objectContaining({ q: "Ada", pageSize: 25 }),
      );
      expect(result.embed).toEqual({
        shop: "owned.myshopify.com",
        host: "YWJj",
        embedded: "1",
      });
      expect(JSON.stringify(result)).not.toMatch(/foreign|id_token|evil.test/);
      expect(mocks.authenticate.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.page.mock.invocationCallOrder[0],
      );
      expect(mocks.subscription.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.page.mock.invocationCallOrder[0],
      );
    },
  );
  it.each([
    ["SUSPENDED", null, true, "/app/merchant-support"],
    ["UNINSTALLED", new Date(), true, "/app/reinstalling"],
    ["UNINSTALLED", null, true, "/auth/login"],
    ["ACTIVE", null, false, "/app"],
  ] as const)(
    "denies %s before any recovery read",
    async (status, reinstallPendingAt, onboardingCompleted, destination) => {
      mocks.shop.mockResolvedValue({
        id: "owned-shop",
        status,
        reinstallPendingAt,
      });
      mocks.settings.mockResolvedValue({ onboardingCompleted });
      const result = await loadRecoveryList(
        request("host=YWJj&embedded=1"),
      ).catch((e) => e as Response);
      expect(result).toBeInstanceOf(Response);
      const location = new URL(
        (result as Response).headers.get("Location")!,
        "https://app.example",
      );
      expect(location.pathname).toBe(destination);
      expect(location.searchParams.get("host")).toBe("YWJj");
      expect(mocks.page).not.toHaveBeenCalled();
      expect(mocks.exists).not.toHaveBeenCalled();
    },
  );
  it("preserves thrown authentication responses", async () => {
    const auth = new Response(null, { status: 401 });
    mocks.authenticate.mockRejectedValueOnce(auth);
    await expect(loadRecoveryList(request())).rejects.toBe(auth);
    expect(mocks.shop).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it.each([
    "from=2026-02-30",
    "from=2026-09-20&to=2026-09-19",
    "to=2026-09-21",
    "from=2020-01-01",
    "status=unknown",
    "pageSize=51",
    "q=" + "a".repeat(101),
    "cursor=e30",
  ])("rejects invalid %s without recovery queries", async (query) => {
    expect((await loadRecoveryList(request(query))).state).toBe("invalid");
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.exists).not.toHaveBeenCalled();
  });
  it("rejects a foreign cursor before recovery reads", async () => {
    const query = normalizeRecoveryQuery(new URLSearchParams(), {
      timeZone: "Europe/London",
    });
    const cursor = encodeRecoveryCursor(query, "foreign", {
      direction: "next",
      detectedAt: row.detectedAt,
      id: "x",
    });
    expect((await loadRecoveryList(request(`cursor=${cursor}`))).error).toBe(
      "cursor",
    );
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it("distinguishes unused history from an empty date/filter page with a bounded owned lookup", async () => {
    mocks.page.mockResolvedValue({
      items: [],
      previousCursor: null,
      nextCursor: null,
    });
    expect((await loadRecoveryList(request("q=nobody"))).state).toBe("empty");
    expect(mocks.exists).toHaveBeenCalledWith({
      where: { shopId: "owned-shop" },
      select: { id: true },
    });
    mocks.exists.mockResolvedValue(null);
    expect((await loadRecoveryList(request())).state).toBe("never-used");
  });
  it("keeps filters and embed context on read failure, without raw error content", async () => {
    mocks.page.mockRejectedValueOnce(new Error("private database detail"));
    const result = await loadRecoveryList(
      request("q=Ada&status=ongoing&host=YWJj"),
    );
    expect(result).toMatchObject({
      state: "error",
      filters: { q: "Ada", status: "ongoing" },
      embed: { host: "YWJj" },
    });
    expect(JSON.stringify(result)).not.toContain("private database");
  });
});

describe("recovery list presentation and navigation", () => {
  it("serializes only normalized filters, retains cursor for return context, and resets it on explicit changes", async () => {
    const data = await loadRecoveryList(request());
    const next = recoveryListUrl(data.filters, data.embed, "next-cursor");
    expect(next).toContain("cursor=next-cursor");
    expect(
      recoveryListUrl(
        { ...data.filters, cursor: "old", q: "Ada&shopId=other" },
        data.embed,
        null,
      ),
    ).not.toContain("cursor=");
    const params = new URL(next, "https://app.example").searchParams;
    expect(params.get("from")).toBe("2026-08-22");
    expect(params.get("to")).toBe("2026-09-20");
  });
  it("renders one safe localized row and no premature detail or mutation controls", async () => {
    const data = await loadRecoveryList(request());
    const router = createMemoryRouter([
      {
        path: "*",
        element: createElement(RecoveryList, { data, onRefresh: () => {} }),
      },
    ]);
    const html = renderToStaticMarkup(
      createElement(RouterProvider, { router }),
    );
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("£100.25");
    expect(html).toContain("/app/recoveries/opaque-private-id?");
    expect(html).not.toContain(">opaque-private-id<");
    expect(html).not.toContain('method="post"');
    expect(html).toContain('type="search"');
    expect(html).toContain('for="recovery-search"');
    expect(html).toContain('name="q"');
    expect(html).not.toContain('name="cursor"');
    expect(html).toContain("Europe/London");
    expect(html).toContain("Next");
    const routes = readFileSync("app/routes.ts", "utf8");
    expect(routes).toContain(
      'route("recoveries", "./routes/app/recoveries/route.tsx")',
    );
    expect(routes).toContain("recoveries/:recoveryId");
  });
  it("renders localized error, empty and busy states with accessible semantics", async () => {
    const data = await loadRecoveryList(request());
    for (const state of ["never-used", "empty", "error", "invalid"] as const) {
      const router = createMemoryRouter([
        {
          path: "*",
          element: createElement(RecoveryList, {
            data: { ...data, state, error: "date" },
            onRefresh: () => {},
          }),
        },
      ]);
      const html = renderToStaticMarkup(
        createElement(RouterProvider, { router }),
      );
      expect(html).toContain(
        state === "error" || state === "invalid"
          ? 'role="alert"'
          : 'role="status"',
      );
    }
    const router = createMemoryRouter([
      {
        path: "*",
        element: createElement(RecoveryList, {
          data,
          busy: true,
          onRefresh: () => {},
        }),
      },
    ]);
    const html = renderToStaticMarkup(
      createElement(RouterProvider, { router }),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading recoveries");
    expect(html).not.toContain("Ada Lovelace");
  });
});

afterEach(() => vi.useRealTimers());
