import "@shopify/shopify-api/adapters/node";
import { createHmac } from "node:crypto";
import { ApiVersion, AppDistribution, LogSeverity, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
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

const sdkCredentials = { apiKey: "shopify-sdk-test-key", apiSecretKey: "shopify-sdk-test-secret" };

function createShopifySdk(coordination: ReturnType<typeof createCoordinatedShopifyAuthentication>) {
  setAbstractFetchFunc(coordination.fetch);
  return shopifyApp({
    ...sdkCredentials,
    apiVersion: ApiVersion.July26,
    scopes: ["read_products", "read_discounts"],
    appUrl: "https://app.example.test",
    authPathPrefix: "/auth",
    distribution: AppDistribution.AppStore,
    sessionStorage: coordination.sessionStorage,
    logger: { level: LogSeverity.Error, httpRequests: false, log: () => undefined },
    future: { expiringOfflineAccessTokens: true },
  });
}

function sessionTokenRequest(domain: string): Request {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: `https://${domain}/admin`,
    dest: `https://${domain}`,
    aud: sdkCredentials.apiKey,
    sub: "sdk-test-user",
    exp: now + 300,
    nbf: now - 5,
    iat: now - 5,
    jti: `sdk-test-${now}`,
    sid: `sdk-session-${now}`,
  })).toString("base64url");
  const signature = createHmac("sha256", sdkCredentials.apiSecretKey).update(`${header}.${payload}`).digest("base64url");
  return new Request(`https://app.example.test/auth/callback?shop=${domain}&code=sdk-session-token-exchange`, {
    headers: { authorization: `Bearer ${header}.${payload}.${signature}` },
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

async function installSdkSession(
  db: LifecyclePostgres,
  app: ReturnType<typeof createCoordinatedShopifyAuthentication>,
  sdk: ReturnType<typeof createShopifySdk>,
  domain: string,
  accessToken: string,
  refreshToken: string,
) {
  const request = sessionTokenRequest(domain);
  await app.withAdminAuthentication(request, () => sdk.authenticate.admin(request));
  const rows = await db.observer.session.findMany({ where: { shop: domain, isOnline: false } });
  const session = rows[0];
  if (!session) throw new Error("The installed Shopify SDK did not persist an offline Session");
  expect(session.accessToken).toBe(accessToken);
  expect(session.refreshToken).toBe(refreshToken);
  return session.id;
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

  it("serializes the installed SDK refresh with an independent Shared client and commits its newly constructed Session", async () => {
    const db = requireFixture();
    const shop = await db.createShop("sdk-shared-refresh");
    const responseReady = deferred<Response>();
    const requestStarted = deferred<void>();
    let fetchCalls = 0;
    const appFetch = vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return refreshResponse("sdk-bootstrap-access", "sdk-bootstrap-refresh");
      requestStarted.resolve();
      return responseReady.promise;
    });
    const app = createCoordinatedShopifyAuthentication({ database: db.primary, nativeFetch: appFetch });
    const sdk = createShopifySdk(app);
    const sessionId = await installSdkSession(db, app, sdk, shop.domain, "sdk-bootstrap-access", "sdk-bootstrap-refresh");
    await db.primary.session.update({ where: { id: sessionId }, data: {
      expires: new Date(Date.now() - 60_000),
      refreshTokenExpires: new Date(Date.now() + 86_400_000),
    } });
    appFetch.mockClear();

    const sharedFetch = vi.fn(async () => refreshResponse("unexpected-shared-access", "unexpected-shared-refresh"));
    const shared = createCoordinatedShopifyAuthentication({ database: db.second, nativeFetch: sharedFetch });

    const originalSession = await db.storage.loadSession(sessionId);
    const sdkAuthentication = app.withUnauthenticatedAdmin(shop.domain, () => sdk.unauthenticated.admin(shop.domain));

    await requestStarted.promise;
    const sharedRead = shared.provider.getAccessToken(shop.id);
    await waitForAdvisoryLockWait(db);
    responseReady.resolve(refreshResponse("sdk-new-access", "sdk-new-refresh"));

    const sdkResult = await sdkAuthentication;
    expect(sdkResult.session.accessToken).toBe("sdk-new-access");
    expect(sdkResult.session).not.toBe(originalSession);
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
    await expect(app.withAdminAuthentication(sessionTokenRequest(shop.domain), () =>
      app.sessionStorage.storeSession(stale),
    )).rejects.toMatchObject({ code: "SESSION_IDENTITY_CONFLICT" });
    expect(await db.observer.session.findUniqueOrThrow({ where: { id: sessionId } }))
      .toMatchObject({ accessToken: "sdk-new-access", refreshToken: "sdk-new-refresh" });
  }, 30_000);

  it("orders actual SDK refresh before concurrent uninstall and actual SDK reinstall exchange through the same domain gate", async () => {
    const db = requireFixture();
    const shop = await db.createShop("sdk-uninstall-race");
    const responseReady = deferred<Response>();
    const requestStarted = deferred<void>();
    let fetchCalls = 0;
    const appFetch = vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return refreshResponse("sdk-bootstrap-access", "sdk-bootstrap-refresh");
      if (fetchCalls === 2) {
        requestStarted.resolve();
        return responseReady.promise;
      }
      return refreshResponse("reinstall-access", "reinstall-refresh");
    });
    const app = createCoordinatedShopifyAuthentication({ database: db.primary, nativeFetch: appFetch });
    const sdk = createShopifySdk(app);
    const sessionId = await installSdkSession(db, app, sdk, shop.domain, "sdk-bootstrap-access", "sdk-bootstrap-refresh");
    await db.primary.session.update({ where: { id: sessionId }, data: {
      expires: new Date(Date.now() - 60_000),
      refreshTokenExpires: new Date(Date.now() + 86_400_000),
    } });
    appFetch.mockClear();

    const authenticated = app.withUnauthenticatedAdmin(shop.domain, () => sdk.unauthenticated.admin(shop.domain));

    await requestStarted.promise;
    const uninstalling = db.service(db.second).markUninstalled(shop.domain, new Date("2026-11-06T00:00:00.000Z"));
    await waitForAdvisoryLockWait(db);
    responseReady.resolve(refreshResponse("refreshed-access", "refreshed-refresh"));

    await expect(authenticated).resolves.toMatchObject({ session: { accessToken: "refreshed-access", refreshToken: "refreshed-refresh" } });
    await expect(uninstalling).resolves.toMatchObject({ kind: "UNINSTALLED", shopId: shop.id });
    expect(await db.observer.shop.findUniqueOrThrow({ where: { id: shop.id } })).toMatchObject({ status: "UNINSTALLED" });
    expect(await db.observer.session.findUnique({ where: { id: sessionId } })).toBeNull();

    const reinstallRequest = sessionTokenRequest(shop.domain);
    const reinstalled = await app.withAdminAuthentication(reinstallRequest, () => sdk.authenticate.admin(reinstallRequest));
    expect(reinstalled.session.accessToken).toBe("reinstall-access");
    expect(await db.observer.session.findUnique({ where: { id: sessionId } }))
      .toMatchObject({ shop: shop.domain, accessToken: "reinstall-access", refreshToken: "reinstall-refresh" });
  }, 30_000);
});
