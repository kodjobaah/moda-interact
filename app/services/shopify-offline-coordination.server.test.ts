import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCoordinatedShopifyAuthentication,
} from "./shopify-offline-coordination.server";
import { ShopifySessionCoordinationRequiredError } from "./shopify-session-storage.server";

function fixture(nativeFetch: typeof fetch, failCommit = false) {
  const domain = "merchant.myshopify.com";
  const shop = { id: "shop-id", domain, platform: "SHOPIFY", status: "ACTIVE" };
  const session = {
    id: "stored-session-id", shop: domain, state: "state", isOnline: false,
    scope: "read_products", expires: new Date(Date.now() - 60_000),
    accessToken: "old-access-token", refreshToken: "old-refresh-token",
    refreshTokenExpires: new Date(Date.now() + 86_400_000), userId: null,
    firstName: null, lastName: null, email: null, accountOwner: false,
    locale: null, collaborator: false, emailVerified: false,
  };
  const transaction = {
    $executeRawUnsafe: vi.fn(async () => 1),
    $queryRawUnsafe: vi.fn(async () => []),
    shop: { findUnique: vi.fn(async () => shop) },
    session: {
      findMany: vi.fn(async () => [session]),
      findUnique: vi.fn(async () => session),
      upsert: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...session, ...data })),
    },
  };
  const database = {
    shop: { findUnique: vi.fn(async () => shop) },
    session: { findMany: vi.fn(async () => [session]) },
    $transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => {
      const result = await work(transaction);
      if (failCommit) throw new Error("transaction commit failed");
      return result;
    }),
  } as unknown as PrismaClient;
  const token = Buffer.from(JSON.stringify({ dest: `https://${domain}` })).toString("base64url");
  const request = new Request(`https://app.example.test/app?shop=${domain}`, {
    headers: { authorization: `Bearer header.${token}.signature` },
  });
  return { coordination: createCoordinatedShopifyAuthentication({ database, nativeFetch }), request, domain };
}

function refreshedSdkSession(domain: string) {
  return {
    id: "stored-session-id",
    shop: domain,
    state: "state",
    isOnline: false,
    scope: "read_products",
    expires: new Date(Date.now() + 3_600_000),
    accessToken: "refresh-access-canary",
    refreshToken: "refresh-token-canary",
    refreshTokenExpires: new Date(Date.now() + 86_400_000),
    toObject: () => ({ refreshToken: "refresh-token-canary" }),
  };
}

function captureRefreshLogs(): string[] {
  const records: string[] = [];
  vi.spyOn(console, "info").mockImplementation((record) => { records.push(String(record)); });
  vi.spyOn(console, "warn").mockImplementation((record) => { records.push(String(record)); });
  return records;
}

afterEach(() => vi.restoreAllMocks());

describe("createCoordinatedShopifyAuthentication", () => {
  it("blocks OAuth transport when there is no offline binding", async () => {
    const nativeFetch = vi.fn(async () => Response.json({ access_token: "unexpected" }));
    const app = fixture(nativeFetch);

    await expect(app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST" }))
      .rejects.toBeInstanceOf(ShopifySessionCoordinationRequiredError);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("bounds the OAuth response and maps an accepted but unusable response to an unknown outcome", async () => {
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(new Uint8Array(16_385), { status: 200 });
    });
    const app = fixture(nativeFetch);

    await expect(app.coordination.withAdminAuthentication(app.request, () =>
      app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST" }),
    )).rejects.toMatchObject({ code: "REFRESH_OUTCOME_UNKNOWN" });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("emits SDK refresh start and committed only after the redirect transaction commits", async () => {
    const records = captureRefreshLogs();
    const nativeFetch = vi.fn(async () => Response.json({
      access_token: "refresh-access-canary",
      refresh_token: "refresh-token-canary",
    }));
    const app = fixture(nativeFetch);

    await expect(app.coordination.withAdminAuthentication(app.request, async () => {
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "request-token-canary" }),
      });
      await app.coordination.sessionStorage.storeSession(refreshedSdkSession(app.domain) as never);
      return new Response(null, { status: 302, headers: { location: "/app" } });
    })).rejects.toMatchObject({ status: 302 });

    const events = records.map((record) => JSON.parse(record) as { event?: string; data?: Record<string, unknown> });
    expect(events.map((event) => event.event)).toEqual([
      "shopify.offline_refresh.started",
      "shopify.offline_refresh.committed",
    ]);
    expect(events[1]?.data).toMatchObject({ source: "SDK", outcome: "COMMITTED", shopId: "shop-id" });
    expect(JSON.stringify(events)).not.toContain("canary");
  });

  it("emits failed UNKNOWN after a successful SDK store whose transaction commit fails", async () => {
    const records = captureRefreshLogs();
    const nativeFetch = vi.fn(async () => Response.json({
      access_token: "refresh-access-canary",
      refresh_token: "refresh-token-canary",
    }));
    const app = fixture(nativeFetch, true);

    await expect(app.coordination.withAdminAuthentication(app.request, async () => {
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "request-token-canary" }),
      });
      await app.coordination.sessionStorage.storeSession(refreshedSdkSession(app.domain) as never);
      return "authenticated";
    })).rejects.toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });

    const events = records.map((record) => JSON.parse(record) as { event?: string; data?: Record<string, unknown> });
    expect(events.map((event) => event.event)).toEqual([
      "shopify.offline_refresh.started",
      "shopify.offline_refresh.failed",
    ]);
    expect(events[1]?.data).toMatchObject({ source: "SDK", outcome: "UNKNOWN", reasonCode: "REFRESH_OUTCOME_UNKNOWN" });
    expect(JSON.stringify(events)).not.toContain("canary");
  });

  it("emits a rejected terminal event when Shopify rejects an SDK refresh", async () => {
    const records = captureRefreshLogs();
    const nativeFetch = vi.fn(async () => Response.json({ errors: ["refresh rejected"] }, { status: 401 }));
    const app = fixture(nativeFetch);

    await expect(app.coordination.withAdminAuthentication(app.request, async () => {
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "request-token-canary" }),
      });
      return "authenticated";
    })).rejects.toMatchObject({ code: "REFRESH_REJECTED" });

    const events = records.map((record) => JSON.parse(record) as { event?: string; data?: Record<string, unknown> });
    expect(events.map((event) => event.event)).toEqual([
      "shopify.offline_refresh.started",
      "shopify.offline_refresh.failed",
    ]);
    expect(events[1]?.data).toMatchObject({ source: "SDK", outcome: "REJECTED", reasonCode: "REFRESH_REJECTED" });
    expect(JSON.stringify(events)).not.toContain("canary");
  });

  it("emits an unknown terminal event when remote acceptance races request abort", async () => {
    const records = captureRefreshLogs();
    const controller = new AbortController();
    const nativeFetch = vi.fn(async () => {
      controller.abort();
      return Response.json({ access_token: "refresh-access-canary", refresh_token: "refresh-token-canary" });
    });
    const app = fixture(nativeFetch);
    const request = new Request(app.request, { signal: controller.signal });

    await expect(app.coordination.withAdminAuthentication(request, async () => {
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "request-token-canary" }),
      });
      return "authenticated";
    })).rejects.toMatchObject({ code: "CANCELLED" });

    const events = records.map((record) => JSON.parse(record) as { event?: string; data?: Record<string, unknown> });
    expect(events.map((event) => event.event)).toEqual([
      "shopify.offline_refresh.started",
      "shopify.offline_refresh.failed",
    ]);
    expect(events[1]?.data).toMatchObject({ source: "SDK", outcome: "UNKNOWN", reasonCode: "REFRESH_OUTCOME_UNKNOWN" });
    expect(JSON.stringify(events)).not.toContain("canary");
  });

  it("does not report authorization-code token exchange as a refresh", async () => {
    const records = captureRefreshLogs();
    const nativeFetch = vi.fn(async () => Response.json({ access_token: "exchange-access", refresh_token: "exchange-refresh" }));
    const app = fixture(nativeFetch);

    await app.coordination.withAdminAuthentication(app.request, async () => {
      const response = await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code", code: "exchange-code-canary" }),
      });
      return response.json();
    });

    expect(records).toEqual([]);
  });

  it("keeps authentication successful when the semantic event log sink throws", async () => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logging sink failure"); });
    const nativeFetch = vi.fn(async () => Response.json({
      access_token: "refresh-access-canary",
      refresh_token: "refresh-token-canary",
    }));
    const app = fixture(nativeFetch);

    await expect(app.coordination.withAdminAuthentication(app.request, async () => {
      const response = await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "request-token-canary" }),
      });
      await response.json();
      await app.coordination.sessionStorage.storeSession(refreshedSdkSession(app.domain) as never);
      return "authenticated";
    })).resolves.toBe("authenticated");
  });
});


describe("bounded SDK refresh observation corrections", () => {
  it.each([false, true])("terminates every SDK dispatch once, commit failure=%s", async (failCommit) => {
    const records = captureRefreshLogs();
    let calls = 0;
    const app = fixture(vi.fn(async () => Response.json(++calls === 1
      ? { access_token: "unstored-access-canary", refresh_token: "unstored-refresh-canary" }
      : { access_token: "refresh-access-canary", refresh_token: "refresh-token-canary" })), failCommit);
    const result = app.coordination.withAdminAuthentication(app.request, async () => {
      for (let i = 0; i < 2; i++) await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }) });
      await app.coordination.sessionStorage.storeSession(refreshedSdkSession(app.domain) as never);
      return "authenticated";
    });
    if (failCommit) await expect(result).rejects.toBeDefined(); else await expect(result).resolves.toBe("authenticated");
    const events = records.map(record => JSON.parse(record));
    const starts = events.filter(event => event.data.outcome === "STARTED");
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map(event => event.data.operationId)).size).toBe(2);
    for (const start of starts) expect(events.filter(event => event.data.operationId === start.data.operationId && event.data.outcome !== "STARTED")).toHaveLength(1);
    if (failCommit) expect(events.some(event => event.data.outcome === "COMMITTED")).toBe(false);
    else {
      const terminal = events.filter(event => event.data.outcome !== "STARTED");
      expect(terminal.map(event => event.data.outcome)).toEqual(["UNKNOWN", "COMMITTED"]);
      expect(terminal[0].data.operationId).toBe(starts[0].data.operationId);
      expect(terminal[1].data.operationId).toBe(starts[1].data.operationId);
    }
    expect(JSON.stringify(events)).not.toContain("canary");
  });

  it("retains remote success when caller abort exits ALS before its work completes", async () => {
    const records = captureRefreshLogs();
    const app = fixture(vi.fn(async () => Response.json({ access_token: "refresh-access-canary", refresh_token: "refresh-token-canary" })));
    const controller = new AbortController();
    const request = new Request(app.request, { signal: controller.signal });
    await expect(app.coordination.withAdminAuthentication(request, async () => {
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }) });
      controller.abort();
      await new Promise(() => undefined);
    })).rejects.toBeDefined();
    const events = records.map(record => JSON.parse(record));
    expect(events.map(event => event.data.outcome)).toEqual(["STARTED", "UNKNOWN"]);
    expect(events[1].data.reasonCode).toBe("REFRESH_OUTCOME_UNKNOWN");
  });

  it.each(["string", "form", "request"])("rejects oversized %s intent before dispatch without exposing body", async (kind) => {
    const records = captureRefreshLogs();
    const fetcher = vi.fn(async () => Response.json({}));
    const app = fixture(fetcher);
    const text = `grant_type=refresh_token&secret=${"x".repeat(17000)}`;
    const request = new Request(`https://${app.domain}/admin/oauth/access_token`, { method: "POST", body: text });
    await expect(app.coordination.withAdminAuthentication(app.request, async () => {
      if (kind === "request") return app.coordination.fetch(request);
      return app.coordination.fetch(request.url, { method: "POST", body: kind === "form" ? new URLSearchParams(text) : text });
    })).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled(); expect(records).toEqual([]); expect(request.bodyUsed).toBe(false);
  });

  it("aborts stalled cloned intent promptly without dispatch or consuming original", async () => {
    const records = captureRefreshLogs();
    const fetcher = vi.fn(async () => Response.json({}));
    const app = fixture(fetcher);
    const controller = new AbortController();
    const request = new Request(`https://${app.domain}/admin/oauth/access_token`, { method: "POST", body: new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("grant_type=refresh_token&")); } }), duplex: "half", signal: controller.signal } as RequestInit);
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await expect(app.coordination.withAdminAuthentication(app.request, () => app.coordination.fetch(request))).rejects.toBeDefined();
      expect(fetcher).not.toHaveBeenCalled(); expect(records).toEqual([]); expect(request.bodyUsed).toBe(false);
    } finally { clearTimeout(timer); void request.body?.cancel().catch(() => undefined); }
  });
});


it("reports UNKNOWN when outer deadline expires after an accepted SDK refresh", async () => {
  vi.useFakeTimers();
  try {
    const records = captureRefreshLogs();
    const app = fixture(vi.fn(async () => Response.json({ access_token: "refresh-access-canary", refresh_token: "refresh-token-canary" })));
    let accepted!: () => void;
    const ready = new Promise<void>(resolve => { accepted = resolve; });
    const result = app.coordination.withAdminAuthentication(app.request, async () => {
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST", body: "grant_type=refresh_token" });
      accepted();
      await new Promise(() => undefined);
    });
    const rejection = expect(result).rejects.toMatchObject({ code: "DEADLINE" });
    await ready;
    await vi.advanceTimersByTimeAsync(15001);
    await rejection;
    const events = records.map(record => JSON.parse(record));
    expect(events.map(event => event.data.outcome)).toEqual(["STARTED", "UNKNOWN"]);
    expect(events[1].data.reasonCode).toBe("REFRESH_OUTCOME_UNKNOWN");
    expect(events[0].data.operationId).toBe(events[1].data.operationId);
  } finally { vi.useRealTimers(); }
});
