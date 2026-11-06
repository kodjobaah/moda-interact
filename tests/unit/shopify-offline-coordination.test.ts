import { Session } from "@shopify/shopify-api";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ShopifyOfflineTokenError } from "@modainteract/moda-interact-shared/shopify/node";
import { createCoordinatedShopifyAuthentication } from "../../app/services/shopify-offline-coordination.server";

type Row = Record<string, unknown> & { id: string; shop: string; isOnline: boolean };

function fixture(options: { tokenResponse?: () => Promise<Response> } = {}) {
  const domain = "merchant.myshopify.com";
  const shop = { id: "shop-selected", domain, platform: "SHOPIFY", status: "ACTIVE", uninstalledAt: null };
  const rows = new Map<string, Row>([["sdk-session-id", {
    id: "sdk-session-id", shop: domain, state: "state", isOnline: false,
    scope: "read_products", expires: new Date(Date.now() - 60_000),
    accessToken: "old-access-token", refreshToken: "old-refresh-token",
    refreshTokenExpires: new Date(Date.now() + 86_400_000), userId: null,
    firstName: null, lastName: null, email: null, accountOwner: false,
    locale: null, collaborator: false, emailVerified: false,
  }]]);
  const counts = { commits: 0, rollbacks: 0, refreshRequests: 0 };

  const session = {
    count: vi.fn(async () => rows.size),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    findMany: vi.fn(async ({ where = {}, take }: { where?: Record<string, unknown>; take?: number }) => {
      const found = [...rows.values()].filter((row) =>
        Object.entries(where).every(([key, expected]) => {
          if (key === "id" && expected && typeof expected === "object" && "in" in expected) {
            return (expected as { in: string[] }).in.includes(row.id);
          }
          return row[key] === expected;
        }),
      );
      return found.slice(0, take ?? found.length);
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: { id: string }; create: Row; update: Partial<Row> }) => {
      const prior = rows.get(where.id);
      const next = { ...(prior ?? create), ...update, ...(!prior ? create : {}) } as Row;
      rows.set(where.id, next);
      return next;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const prior = rows.get(where.id);
      if (!prior) throw new Error("session missing");
      const next = { ...prior, ...data } as Row;
      rows.set(where.id, next);
      return next;
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const prior = rows.get(where.id);
      rows.delete(where.id);
      return prior;
    }),
    deleteMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> }) => {
      const matches = await session.findMany({ where });
      matches.forEach((row) => rows.delete(row.id));
      return { count: matches.length };
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
  const shopDelegate = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; domain?: string } }) =>
      where.id === shop.id || where.domain === shop.domain ? shop : null),
  };
  const transaction = {
    $executeRawUnsafe: vi.fn(async () => 1),
    $queryRawUnsafe: vi.fn(async () => []),
    $queryRaw: vi.fn(async () => []),
    session,
    shop: shopDelegate,
  };
  const database = {
    $transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => {
      const before = structuredClone([...rows.entries()]);
      try {
        const value = await work(transaction);
        counts.commits += 1;
        return value;
      } catch (error) {
        rows.clear();
        before.forEach(([id, row]) => rows.set(id, row));
        counts.rollbacks += 1;
        throw error;
      }
    }),
    shop: shopDelegate,
    session,
  } as unknown as PrismaClient;
  const nativeFetch = vi.fn(async () => {
    counts.refreshRequests += 1;
    return options.tokenResponse ? options.tokenResponse() : Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
  });
  const coordination = createCoordinatedShopifyAuthentication({ database, nativeFetch });
  return { domain, shop, rows, counts, session, database, nativeFetch, coordination };
}

function bearerFor(domain: string): string {
  const payload = Buffer.from(JSON.stringify({ dest: `https://${domain}` })).toString("base64url");
  return `header.${payload}.signature`;
}

function request(domain?: string): Request {
  const url = new URL("https://app.example.test/app");
  if (domain) url.searchParams.set("shop", domain);
  return new Request(url, { headers: domain ? { authorization: `Bearer ${bearerFor(domain)}` } : {} });
}

describe("App Shopify offline authentication coordination", () => {
  it("exports only the coordinated facade and does not expose raw SDK auth or storage", async () => {
    const source = await readFile(new URL("../../app/shopify.server.js", import.meta.url), "utf8");

    expect(source).toContain("export default shopifyFacade");
    expect(source).toContain("export const authenticate = shopifyFacade.authenticate");
    expect(source).toContain("export const sessionStorage = shopifyFacade.sessionStorage");
    expect(source).not.toMatch(/export\s+default\s+shopify\s*;/);
    expect(source).not.toMatch(/export\s+const\s+authenticate\s*=\s*shopify\.authenticate/);
    expect(source).not.toMatch(/export\s+const\s+sessionStorage\s*=\s*shopify\.sessionStorage/);
  });

  it("commits a successful SDK token store before rethrowing its redirect", async () => {
    const app = fixture();
    const redirect = new Response(null, { status: 302, headers: { location: "/auth/callback" } });

    await expect(app.coordination.withAdminAuthentication(request(app.domain), async () => {
      const response = await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, {
        method: "POST",
        body: "grant_type=refresh_token",
      });
      expect(response.status).toBe(200);
      const session = await app.coordination.sessionStorage.loadSession("sdk-session-id");
      expect(session).toBeInstanceOf(Session);
      session!.accessToken = "refreshed-access-token";
      session!.refreshToken = "refreshed-refresh-token";
      await app.coordination.sessionStorage.storeSession(session!);
      throw redirect;
    })).rejects.toBe(redirect);

    expect(app.counts).toEqual({ commits: 1, rollbacks: 0, refreshRequests: 1 });
    expect(app.rows.get("sdk-session-id")).toMatchObject({
      accessToken: "refreshed-access-token",
      refreshToken: "refreshed-refresh-token",
    });
  });

  it("rolls back a failure Response even if an SDK session write was attempted", async () => {
    const app = fixture();
    const failure = new Response("failure", { status: 500 });

    await expect(app.coordination.withAdminAuthentication(request(app.domain), async () => {
      const session = await app.coordination.sessionStorage.loadSession("sdk-session-id");
      session!.accessToken = "must-roll-back";
      await app.coordination.sessionStorage.storeSession(session!);
      throw failure;
    })).rejects.toBe(failure);

    expect(app.counts).toEqual({ commits: 0, rollbacks: 1, refreshRequests: 0 });
    expect(app.rows.get("sdk-session-id")?.accessToken).toBe("old-access-token");
  });

  it("rejects a session for a different authenticated shop before any OAuth request", async () => {
    const app = fixture();
    app.rows.set("foreign-session", {
      ...app.rows.get("sdk-session-id")!,
      id: "foreign-session",
      shop: "other.myshopify.com",
    });

    await expect(app.coordination.withAdminAuthentication(request(app.domain), async () => {
      await app.coordination.sessionStorage.loadSession("foreign-session");
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST" });
    })).rejects.toMatchObject({ code: "SESSION_IDENTITY_CONFLICT" });

    expect(app.nativeFetch).not.toHaveBeenCalled();
    expect(app.counts.commits).toBe(0);
    expect(app.counts.rollbacks).toBe(1);
  });

  it("does not allow offline writes when no request hint established a binding", async () => {
    const app = fixture();

    await expect(app.coordination.withAdminAuthentication(request(), () =>
      app.coordination.sessionStorage.storeSession(new Session({
        id: "sdk-session-id", shop: app.domain, state: "state", isOnline: false, accessToken: "new-access",
      })),
    )).rejects.toMatchObject({ code: "COORDINATION_REQUIRED" });

    expect(app.nativeFetch).not.toHaveBeenCalled();
    expect(app.database.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a token request for any host except the bound stored integration domain", async () => {
    const app = fixture();

    await expect(app.coordination.withAdminAuthentication(request(app.domain), async () => {
      await app.coordination.fetch("https://attacker.example/admin/oauth/access_token", { method: "POST" });
    })).rejects.toBeInstanceOf(ShopifyOfflineTokenError);

    expect(app.nativeFetch).not.toHaveBeenCalled();
  });

  it("returns a stable rejection when Shopify rejects the refresh request", async () => {
    const app = fixture({ tokenResponse: async () => new Response("opaque provider body", { status: 401 }) });

    await expect(app.coordination.withAdminAuthentication(request(app.domain), async () => {
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST" });
    })).rejects.toMatchObject({ code: "REFRESH_REJECTED" });

    expect(app.counts.commits).toBe(0);
    expect(app.counts.rollbacks).toBe(1);
  });

  it("aborts a token request at the eight-second network budget", async () => {
    vi.useFakeTimers();
    try {
      const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const app = fixture({ tokenResponse: async () => Response.json({}) });
      const coordination = createCoordinatedShopifyAuthentication({ database: app.database, nativeFetch });
      const pending = coordination.withAdminAuthentication(request(app.domain), () =>
        coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST" }),
      );
      const rejection = expect(pending).rejects.toMatchObject({ code: "REFRESH_OUTCOME_UNKNOWN" });

      await vi.advanceTimersByTimeAsync(8_001);
      await rejection;
      expect(nativeFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unknown outcome if the SDK fails after Shopify accepted the refresh", async () => {
    const app = fixture();

    await expect(app.coordination.withAdminAuthentication(request(app.domain), async () => {
      await app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST" });
      throw new Error("SDK session persistence failed with opaque credentials");
    })).rejects.toMatchObject({ code: "REFRESH_OUTCOME_UNKNOWN" });

    expect(app.counts.commits).toBe(0);
    expect(app.counts.rollbacks).toBe(1);
  });

  it("rejects a stale SDK Session object from an earlier authentication lock", async () => {
    const app = fixture();
    let stale: Session | undefined;

    await app.coordination.withAdminAuthentication(request(app.domain), async () => {
      stale = await app.coordination.sessionStorage.loadSession("sdk-session-id");
    });
    stale!.accessToken = "stale-access-token";
    stale!.refreshToken = "stale-refresh-token";

    await expect(app.coordination.withAdminAuthentication(request(app.domain), () =>
      app.coordination.sessionStorage.storeSession(stale!),
    )).rejects.toMatchObject({ code: "SESSION_IDENTITY_CONFLICT" });

    expect(app.rows.get("sdk-session-id")).toMatchObject({
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
    });
  });
});
