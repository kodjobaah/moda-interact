import { Session } from "@shopify/shopify-api";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCoordinatedShopifyAuthentication } from "../../app/services/shopify-offline-coordination.server";
import { deferred, startLifecyclePostgres, type LifecyclePostgres } from "../helpers/shopify-lifecycle-postgres";

const enabled = process.env.MODA_SHOPIFY_LIFECYCLE_POSTGRES === "1";
const describeWithPostgres = enabled ? describe : describe.skip;
let fixture: LifecyclePostgres | undefined;

function requireFixture() {
  if (!fixture) throw new Error("Shopify offline coordination PostgreSQL fixture is unavailable");
  return fixture;
}

function adminRequest(domain: string): Request {
  const token = Buffer.from(JSON.stringify({ dest: `https://${domain}` })).toString("base64url");
  return new Request(`https://app.example.test/app?shop=${domain}`, {
    headers: { authorization: `Bearer header.${token}.signature` },
  });
}

function refreshResponse(accessToken: string, refreshToken: string): Response {
  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3_600,
    refresh_token_expires_in: 86_400,
    scope: "read_products,read_discounts",
  });
}

function installRefresh(session: Session, accessToken: string, refreshToken: string): void {
  session.accessToken = accessToken;
  session.refreshToken = refreshToken;
  session.expires = new Date(Date.now() + 3_600_000);
  session.refreshTokenExpires = new Date(Date.now() + 86_400_000);
}

async function waitForAdvisoryLockWait(db: LifecyclePostgres): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.observer.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `);
    if ((rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The second Prisma client did not reach the shared advisory gate while SDK refresh held it");
}

describeWithPostgres("App Shopify offline coordination PostgreSQL", () => {
  beforeAll(async () => { fixture = await startLifecyclePostgres("App SDK offline coordination"); }, 240_000);
  afterAll(async () => { await fixture?.stop(); }, 60_000);

  it("serializes App SDK refresh with an independent Shared client and commits only the newest pair", async () => {
    const db = requireFixture();
    const shop = await db.createShop("sdk-shared-refresh");
    const sessionId = `${shop.id}-stored-session`;
    const expired = db.session(
      shop.domain,
      sessionId,
      "old-access-pair",
      new Date(Date.now() - 60_000),
      "old-refresh-pair",
    );
    expired.refreshTokenExpires = new Date(Date.now() + 86_400_000);
    await db.storage.storeSession(expired);

    const responseReady = deferred<Response>();
    const requestStarted = deferred<void>();
    const appFetch = vi.fn(async () => {
      requestStarted.resolve();
      return responseReady.promise;
    });
    const app = createCoordinatedShopifyAuthentication({ database: db.primary, nativeFetch: appFetch });
    const sharedFetch = vi.fn(async () => refreshResponse("unexpected-shared-access", "unexpected-shared-refresh"));
    const shared = createCoordinatedShopifyAuthentication({ database: db.second, nativeFetch: sharedFetch });

    const sdkAuthentication = app.withAdminAuthentication(adminRequest(shop.domain), async () => {
      const session = await app.sessionStorage.loadSession(sessionId);
      if (!session) throw new Error("Expected the installed offline Session");
      const response = await app.fetch(`https://${shop.domain}/admin/oauth/access_token`, { method: "POST" });
      const payload = await response.json() as { access_token: string; refresh_token: string };
      installRefresh(session, payload.access_token, payload.refresh_token);
      await app.sessionStorage.storeSession(session);
      return "sdk-authenticated";
    });

    await requestStarted.promise;
    const sharedRead = shared.provider.getAccessToken(shop.id);
    await waitForAdvisoryLockWait(db);
    responseReady.resolve(refreshResponse("sdk-new-access", "sdk-new-refresh"));

    await expect(sdkAuthentication).resolves.toBe("sdk-authenticated");
    await expect(sharedRead).resolves.toBe("sdk-new-access");
    expect(appFetch).toHaveBeenCalledTimes(1);
    expect(sharedFetch).not.toHaveBeenCalled();
    const persisted = await db.observer.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(persisted).toMatchObject({
      shop: shop.domain,
      accessToken: "sdk-new-access",
      refreshToken: "sdk-new-refresh",
    });

    const stale = db.session(shop.domain, sessionId, "old-access-pair", new Date(Date.now() - 60_000), "old-refresh-pair");
    await expect(app.withAdminAuthentication(adminRequest(shop.domain), () =>
      app.sessionStorage.storeSession(stale),
    )).rejects.toMatchObject({ code: "SESSION_IDENTITY_CONFLICT" });
    expect(await db.observer.session.findUniqueOrThrow({ where: { id: sessionId } }))
      .toMatchObject({ accessToken: "sdk-new-access", refreshToken: "sdk-new-refresh" });
  }, 30_000);

  it("orders verified SDK persistence before concurrent uninstall through the same domain gate", async () => {
    const db = requireFixture();
    const shop = await db.createShop("sdk-uninstall-race");
    const sessionId = `${shop.id}-offline`;
    await db.storage.storeSession(db.session(shop.domain, sessionId, "old-access", new Date(Date.now() - 60_000), "old-refresh"));

    const responseReady = deferred<Response>();
    const requestStarted = deferred<void>();
    const app = createCoordinatedShopifyAuthentication({
      database: db.primary,
      nativeFetch: async () => {
        requestStarted.resolve();
        return responseReady.promise;
      },
    });
    const authenticated = app.withAdminAuthentication(adminRequest(shop.domain), async () => {
      const session = await app.sessionStorage.loadSession(sessionId);
      if (!session) throw new Error("Expected the installed offline Session");
      const response = await app.fetch(`https://${shop.domain}/admin/oauth/access_token`, { method: "POST" });
      const payload = await response.json() as { access_token: string; refresh_token: string };
      installRefresh(session, payload.access_token, payload.refresh_token);
      await app.sessionStorage.storeSession(session);
      return "refreshed";
    });

    await requestStarted.promise;
    const uninstalling = db.service(db.second).markUninstalled(shop.domain, new Date("2026-11-06T00:00:00.000Z"));
    await waitForAdvisoryLockWait(db);
    responseReady.resolve(refreshResponse("refreshed-access", "refreshed-refresh"));

    await expect(authenticated).resolves.toBe("refreshed");
    await expect(uninstalling).resolves.toMatchObject({ kind: "UNINSTALLED", shopId: shop.id });
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } })).toMatchObject({ status: "UNINSTALLED" });
    expect(await db.observer.session.findUnique({ where: { id: sessionId } })).toBeNull();

    const reinstallSessionId = `${shop.id}-sdk-reinstall-session`;
    const reinstallToken = Buffer.from(JSON.stringify({ dest: `https://${shop.domain}` })).toString("base64url");
    const callbackRequest = new Request(`https://app.example.test/auth/callback?shop=${shop.domain}&code=verified-by-sdk`, {
      headers: { authorization: `Bearer header.${reinstallToken}.signature` },
    });
    const redirect = new Response(null, { status: 302, headers: { location: "/app" } });

    await expect(app.withAdminAuthentication(callbackRequest, async () => {
      const reinstallSession = new Session({
        id: reinstallSessionId,
        shop: shop.domain,
        state: "sdk-reinstall",
        isOnline: false,
        accessToken: "reinstall-access",
        refreshToken: "reinstall-refresh",
        refreshTokenExpires: new Date(Date.now() + 86_400_000),
      });
      await app.sessionStorage.storeSession(reinstallSession);
      throw redirect;
    })).rejects.toBe(redirect);
    expect(await db.observer.session.findUnique({ where: { id: reinstallSessionId } }))
      .toMatchObject({ shop: shop.domain, accessToken: "reinstall-access", refreshToken: "reinstall-refresh" });
  }, 30_000);
});
