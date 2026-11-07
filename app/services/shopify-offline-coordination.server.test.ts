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

  it("emits a cancelled terminal event when the request aborts after refresh dispatch", async () => {
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
    expect(events[1]?.data).toMatchObject({ source: "SDK", outcome: "CANCELLED", reasonCode: "CANCELLED" });
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
