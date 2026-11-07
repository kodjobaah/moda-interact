import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ShopifyOfflineTokenError,
  createShopifyOfflineTokenProvider,
  type ShopifyOfflineDatabase,
  type ShopifyOfflineRefreshEvent,
  type ShopifyOfflineTokenErrorCode,
} from "@modainteract/moda-interact-shared/shopify/node";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import type { AbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { lockShopLifecycleRow } from "./discounts/shopify-discount-lifecycle.service";
import { createDefaultShopifyPlatformConfigurationService } from "./platform-configuration/composition.server";
import { recordShopifyOfflineRefreshEvent } from "./observability/shopify-runtime-observability.server";
import prisma from "../db.server";
import {
  CoordinatedShopifySessionStorage,
  getShopifySessionBinding,
  runWithShopifySessionBinding,
  ShopifySessionCoordinationRequiredError,
  recordShopifyOAuthCredentialResponse,
  type ShopifySessionCoordinationContext,
  type SdkRefreshAttempt,
} from "./shopify-session-storage.server";

const NETWORK_BUDGET_MS = 8_000;
const AUTH_CALLBACK_BUDGET_MS = 15_000;
const MAX_OAUTH_RESPONSE_BYTES = 16_384;
const MAX_OAUTH_INTENT_BYTES = 16_384;

type ShopIdentity = Readonly<{
  id: string;
  domain: string;
  platform: string;
  status: string;
  uninstalledAt?: Date | null;
}>;

type CapturedResult<T> =
  | { kind: "value"; value: T }
  | { kind: "response"; response: Response }
  | { kind: "error"; error: unknown };

type WithAuthenticationLock<Context> = <T>(
  work: (context: Context) => Promise<T>,
) => Promise<T>;

type LifecycleInput = {
  transaction: Prisma.TransactionClient;
  shop: ShopIdentity | null;
  sessionId: string | null;
};

type LifecycleWork<T> = (input: LifecycleInput) => Promise<T>;

export type CoordinatedShopifyAuthentication = Readonly<{
  provider: ReturnType<typeof createShopifyOfflineTokenProvider>;
  sessionStorage: SessionStorage & { isReady(): Promise<boolean> };
  fetch: AbstractFetchFunc;
  withAdminAuthentication<T>(request: Request, authenticate: () => Promise<T>): Promise<T>;
  withWebhookAuthentication<T>(request: Request, authenticate: () => Promise<T>): Promise<T>;
  withUnauthenticatedAdmin<T>(shop: string, authenticate: () => Promise<T>): Promise<T>;
  withLifecycleLock<T>(integrationDomain: string, work: LifecycleWork<T>, options?: { sessionId?: string | null }): Promise<T>;
}>;

function createOfflineProvider(database: PrismaClient, fetchImpl: typeof fetch) {
  const structuralDatabase = database as unknown as ShopifyOfflineDatabase;
  return createShopifyOfflineTokenProvider({
    prisma: structuralDatabase,
    readOAuth: () => createDefaultShopifyPlatformConfigurationService().requireShopifyOAuthCredentials(),
    fetch: fetchImpl,
    onEvent: recordShopifyOfflineRefreshEvent,
  });
}

function getRequestHint(request: Request, surface: "admin" | "webhook"): string | undefined {
  if (surface === "webhook") {
    return request.headers.get("x-shopify-shop-domain") ?? undefined;
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^\s*Bearer\s+([^\s]+)\s*$/i)?.[1];
  const bearerDomain = bearer ? jwtDestination(bearer) : undefined;
  if (bearerDomain) return bearerDomain;

  const url = new URL(request.url);
  for (const tokenName of ["id_token", "session"]) {
    const token = url.searchParams.get(tokenName);
    const tokenDomain = token ? jwtDestination(token) : undefined;
    if (tokenDomain) return tokenDomain;
  }
  return url.searchParams.get("shop") ?? undefined;
}

function jwtDestination(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { dest?: unknown };
    if (typeof decoded.dest !== "string") return undefined;
    return new URL(decoded.dest).host || undefined;
  } catch {
    return undefined;
  }
}

function isOAuthCallback(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname.startsWith("/auth/") && Boolean(url.searchParams.get("code"));
}

function canCommitResponse(result: CapturedResult<unknown>, stores: number): boolean {
  return result.kind === "response" && result.response.status >= 300 && result.response.status < 400 && stores > 0;
}

function tokenRequestUrl(input: RequestInfo | URL): URL | undefined {
  let value: string;
  if (typeof input === "string") value = input;
  else if (input instanceof URL) value = input.toString();
  else value = input.url;
  try {
    const url = new URL(value);
    return url.pathname.endsWith("/admin/oauth/access_token") ? url : undefined;
  } catch {
    return undefined;
  }
}

async function isRefreshTokenGrant(input: RequestInfo | URL, init: RequestInit | undefined, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  let body = init?.body;
  let text: string;
  if (body instanceof URLSearchParams) {
    // Count without serializing an unbounded form. Encoding only expands this bound.
    let size = 0;
    for (const [key, value] of body) {
      size += Buffer.byteLength(key) + Buffer.byteLength(value);
      if (size > MAX_OAUTH_INTENT_BYTES) throw new ShopifyOfflineTokenError("INVALID_SESSION");
    }
    text = body.toString();
  } else if (typeof body === "string") text = body;
  else if (body === undefined && input instanceof Request) {
    const clone = input.clone();
    const reader = clone.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ShopifyOfflineTokenError("DEADLINE"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_OAUTH_INTENT_BYTES) throw new ShopifyOfflineTokenError("INVALID_SESSION");
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      // A tee's cancellation can wait for its original branch; never await it.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else return false;
  signal.throwIfAborted();
  if (Buffer.byteLength(text) > MAX_OAUTH_INTENT_BYTES) throw new ShopifyOfflineTokenError("INVALID_SESSION");
  try {
    const form = new URLSearchParams(text);
    if (form.has("grant_type")) return form.get("grant_type") === "refresh_token";
    return (JSON.parse(text) as { grant_type?: unknown }).grant_type === "refresh_token";
  } catch { return false; }
}

function emitSdkRefreshEvent(
  attempt: SdkRefreshAttempt,
  event: ShopifyOfflineRefreshEvent["event"],
  outcome: ShopifyOfflineRefreshEvent["outcome"],
  reasonCode: ShopifyOfflineTokenErrorCode | null,
): void {
  const record: ShopifyOfflineRefreshEvent = Object.freeze({
    event,
    operationId: attempt.operationId,
    shopId: attempt.shopId,
    source: "SDK" as const,
    durationMs: Math.min(60_000, Math.max(0, Math.round(performance.now() - attempt.startedAt))),
    outcome,
    reasonCode,
  });
  try { void Promise.resolve(recordShopifyOfflineRefreshEvent(record)).catch(() => undefined); } catch { /* Telemetry cannot change authentication outcomes. */ }
}

function sdkRefreshFailure(error: unknown, tokenOutcome: "none" | "rejected" | "succeeded" | "unknown"):
  { outcome: "REJECTED" | "UNKNOWN" | "CANCELLED" | "UNAVAILABLE"; reasonCode: ShopifyOfflineTokenErrorCode } {
  const code = error instanceof ShopifyOfflineTokenError ? error.code : null;
  if (tokenOutcome === "unknown" || tokenOutcome === "succeeded" || code === "REFRESH_OUTCOME_UNKNOWN") {
    return { outcome: "UNKNOWN", reasonCode: "REFRESH_OUTCOME_UNKNOWN" };
  }
  if (code === "REFRESH_REJECTED" || tokenOutcome === "rejected") return { outcome: "REJECTED", reasonCode: "REFRESH_REJECTED" };
  if (code === "CANCELLED") return { outcome: "CANCELLED", reasonCode: "CANCELLED" };
  if (code === "DEADLINE") return { outcome: "CANCELLED", reasonCode: "DEADLINE" };
  return { outcome: "UNAVAILABLE", reasonCode: code ?? "PERSISTENCE_UNAVAILABLE" };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_OAUTH_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new ShopifyOfflineTokenError("REFRESH_OUTCOME_UNKNOWN");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new ShopifyOfflineTokenError("DEADLINE");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OAUTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ShopifyOfflineTokenError("REFRESH_OUTCOME_UNKNOWN");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function combineSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function createBoundedFetch(nativeFetch: typeof fetch): AbstractFetchFunc {
  return async (input, init) => {
    const binding = getShopifySessionBinding();
    const tokenUrl = tokenRequestUrl(input);
    if (!binding) {
      if (tokenUrl) throw new ShopifySessionCoordinationRequiredError();
      return nativeFetch(input, init);
    }
    if (binding.closed) throw new ShopifySessionCoordinationRequiredError();

    const request = input instanceof Request ? input : undefined;
    const callerSignal = init?.signal ?? request?.signal;
    const timeoutController = new AbortController();
    const budgetMs = tokenUrl ? NETWORK_BUDGET_MS : AUTH_CALLBACK_BUDGET_MS;
    const timeout = setTimeout(() => timeoutController.abort(), budgetMs);
    const signal = combineSignals([callerSignal, binding.signal, timeoutController.signal]);
    let tokenDispatched = false;
    let sdkRefreshAttempt: SdkRefreshAttempt | null = null;

    try {
      if (tokenUrl) {
        if (
          tokenUrl.protocol !== "https:" ||
          tokenUrl.host !== binding.context.shop ||
          (init?.method ?? request?.method ?? "GET").toUpperCase() !== "POST"
        ) {
          throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
        }
        const isRefresh = await isRefreshTokenGrant(input, init, signal ?? timeoutController.signal);
        if (binding.closed || signal?.aborted) throw new ShopifyOfflineTokenError("DEADLINE");
        if (isRefresh) {
          sdkRefreshAttempt = {
            operationId: randomUUID(),
            startedAt: performance.now(),
            shopId: binding.context.shopId,
            tokenOutcome: "none", credentialFingerprint: null, persisted: false,
          };
          binding.sdkRefreshAttempts.push(sdkRefreshAttempt);
          binding.onSdkRefreshAttempt?.(sdkRefreshAttempt);
          emitSdkRefreshEvent(sdkRefreshAttempt, "shopify.offline_refresh.started", "STARTED", null);
        }
        tokenDispatched = true;
      }

      const response = await nativeFetch(input, {
        ...init,
        ...(tokenUrl ? { method: "POST", redirect: "error" as RequestRedirect } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!tokenUrl) return response;

      if (response.status >= 400 && response.status < 500) {
        binding.tokenOutcome = "rejected";
        if (sdkRefreshAttempt) sdkRefreshAttempt.tokenOutcome = "rejected";
        await response.body?.cancel().catch(() => undefined);
        throw new ShopifyOfflineTokenError("REFRESH_REJECTED");
      }
      if (!response.ok) {
        binding.tokenOutcome = "unknown";
        if (sdkRefreshAttempt) sdkRefreshAttempt.tokenOutcome = "unknown";
        await response.body?.cancel().catch(() => undefined);
        throw new ShopifyOfflineTokenError("REFRESH_OUTCOME_UNKNOWN");
      }
      binding.tokenOutcome = "succeeded";
      if (sdkRefreshAttempt) sdkRefreshAttempt.tokenOutcome = "succeeded";

      let body: Uint8Array | null;
      try {
        body = await readBoundedBody(response, signal ?? timeoutController.signal);
      } catch (error) {
        if (callerSignal?.aborted) throw new ShopifyOfflineTokenError("CANCELLED");
        binding.tokenOutcome = "unknown";
        if (error instanceof ShopifyOfflineTokenError) throw error;
        throw new ShopifyOfflineTokenError("REFRESH_OUTCOME_UNKNOWN");
      }
      const bodyBuffer = body === null ? null : new ArrayBuffer(body.byteLength);
      if (body !== null && bodyBuffer !== null) {
        recordShopifyOAuthCredentialResponse(body, sdkRefreshAttempt ?? undefined);
        new Uint8Array(bodyBuffer).set(body);
      }
      return new Response(bodyBuffer, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (tokenUrl && tokenDispatched && binding.tokenOutcome === "none") binding.tokenOutcome = "unknown";
      if (sdkRefreshAttempt?.tokenOutcome === "none") sdkRefreshAttempt.tokenOutcome = "unknown";
      if (callerSignal?.aborted) throw new ShopifyOfflineTokenError("CANCELLED");
      if (binding.signal.aborted) throw new ShopifyOfflineTokenError("DEADLINE");
      if (timeoutController.signal.aborted) {
        throw new ShopifyOfflineTokenError(tokenUrl ? "REFRESH_OUTCOME_UNKNOWN" : "DEADLINE");
      }
      if (error instanceof ShopifyOfflineTokenError || error instanceof ShopifySessionCoordinationRequiredError) throw error;
      if (tokenUrl) throw new ShopifyOfflineTokenError("REFRESH_OUTCOME_UNKNOWN");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function statusFailure(): never {
  throw new ShopifyOfflineTokenError("INVALID_SESSION");
}

export function createCoordinatedShopifyAuthentication(input: {
  database?: PrismaClient;
  nativeFetch?: typeof fetch;
} = {}): CoordinatedShopifyAuthentication {
  const database = input.database ?? prisma;
  const nativeFetch = input.nativeFetch ?? globalThis.fetch.bind(globalThis);
  const provider = createOfflineProvider(database, nativeFetch);
  const coordinatedFetch = createBoundedFetch(nativeFetch);
  let sessionStorage: CoordinatedShopifySessionStorage | undefined;

  async function invokeInLock<T>(
    run: WithAuthenticationLock<ShopifySessionCoordinationContext>,
    authenticate: () => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const sdkRefreshAttempts: SdkRefreshAttempt[] = [];
    let committedResponse: CapturedResult<T>;
    try {
      committedResponse = await run<CapturedResult<T>>(async (context) => {
      const bound = await runWithShopifySessionBinding(context, async () => {
        try {
          const value = await authenticate();
          return value instanceof Response
            ? { kind: "response", response: value } as CapturedResult<T>
            : { kind: "value", value } as CapturedResult<T>;
        } catch (error) {
          if (error instanceof Response) return { kind: "response", response: error } as CapturedResult<T>;
          return { kind: "error", error } as CapturedResult<T>;
        }
      }, callerSignal, 15_000, (attempt) => { sdkRefreshAttempts.push(attempt); });
      const result = bound.value;
      if (canCommitResponse(result, bound.successfulOfflineStores)) return result;
      if (result.kind === "error") {
        if (bound.tokenOutcome === "succeeded" || bound.tokenOutcome === "unknown") {
          throw new ShopifyOfflineTokenError("REFRESH_OUTCOME_UNKNOWN");
        }
        if (bound.tokenOutcome === "rejected") throw new ShopifyOfflineTokenError("REFRESH_REJECTED");
        throw result.error;
      }
      if (result.kind === "response") {
        if (bound.tokenOutcome === "succeeded" || bound.tokenOutcome === "unknown") {
          throw new ShopifyOfflineTokenError("REFRESH_OUTCOME_UNKNOWN");
        }
        if (bound.tokenOutcome === "rejected") throw new ShopifyOfflineTokenError("REFRESH_REJECTED");
        throw result.response;
      }
      return result;
      });
    } catch (error) {
      for (const attempt of sdkRefreshAttempts) {
        const failure = sdkRefreshFailure(error, attempt.tokenOutcome);
        emitSdkRefreshEvent(attempt, "shopify.offline_refresh.failed", failure.outcome, failure.reasonCode);
      }
      throw error;
    }
    for (const attempt of sdkRefreshAttempts) {
      if (attempt.persisted && attempt.tokenOutcome === "succeeded") {
        emitSdkRefreshEvent(attempt, "shopify.offline_refresh.committed", "COMMITTED", null);
      } else {
        const failure = sdkRefreshFailure(undefined, attempt.tokenOutcome);
        emitSdkRefreshEvent(attempt, "shopify.offline_refresh.failed", failure.outcome, failure.reasonCode);
      }
    }
    if (committedResponse.kind === "error") throw committedResponse.error;
    if (committedResponse.kind === "response") throw committedResponse.response;
    return committedResponse.value;
  }

  async function withShopHint<T>(
    integrationDomain: string | undefined,
    authenticate: () => Promise<T>,
    options: { surface: "admin" | "webhook" | "unauthenticated"; request?: Request },
  ): Promise<T> {
    if (!integrationDomain) return authenticate();

    const shop = await database.shop.findUnique({
      where: { domain: integrationDomain },
      select: { id: true, domain: true, platform: true, status: true },
    });

    if (shop && shop.platform !== "SHOPIFY") statusFailure();

    const isBootstrapRequest =
      options.surface === "webhook" ||
      (options.surface === "admin" && isOAuthCallback(options.request!));

    if (shop && shop.status !== "ACTIVE" && !isBootstrapRequest) statusFailure();
    if (shop && shop.status === "ACTIVE") {
      const sessions = await database.session.findMany({
        where: { shop: shop.domain, isOnline: false },
        select: { id: true },
        take: 2,
      });
      if (sessions.length > 1) throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
      if (sessions.length === 1) {
        return invokeInLock(
          (work) => provider.withSessionLock(shop.id, work, { signal: options.request?.signal }),
          authenticate,
          options.request?.signal,
        );
      }
      if (!isBootstrapRequest) throw new ShopifyOfflineTokenError("SESSION_MISSING");
    }

    if (options.surface === "unauthenticated") throw new ShopifyOfflineTokenError("SESSION_MISSING");
    return invokeInLock(
      (work) => provider.withSdkInstallationSessionLock(integrationDomain, work),
      authenticate,
      options.request?.signal,
    );
  }

  return Object.freeze({
    provider,
    get sessionStorage() {
      sessionStorage ??= new CoordinatedShopifySessionStorage(database);
      return sessionStorage;
    },
    fetch: coordinatedFetch,
    withAdminAuthentication<T>(request: Request, authenticate: () => Promise<T>) {
      return withShopHint(getRequestHint(request, "admin"), authenticate, { surface: "admin", request });
    },
    withWebhookAuthentication<T>(request: Request, authenticate: () => Promise<T>) {
      return withShopHint(getRequestHint(request, "webhook"), authenticate, { surface: "webhook", request });
    },
    withUnauthenticatedAdmin<T>(shop: string, authenticate: () => Promise<T>) {
      return withShopHint(shop, authenticate, { surface: "unauthenticated" });
    },
    async withLifecycleLock<T>(
      integrationDomain: string,
      work: LifecycleWork<T>,
      options: { sessionId?: string | null } = {},
    ): Promise<T> {
      return provider.withSdkInstallationSessionLock(integrationDomain, async (context) => {
        const transaction = context.transaction as unknown as Prisma.TransactionClient;
        const shop = await transaction.shop.findUnique({
          where: { domain: integrationDomain },
          select: { id: true, domain: true, platform: true, status: true },
        });
        if (shop && shop.platform !== "SHOPIFY") statusFailure();
        if (!shop) return work({ transaction, shop: null, sessionId: null });

        await lockShopLifecycleRow(transaction, shop.id);
        const currentShop = await transaction.shop.findUnique({
          where: { id: shop.id },
          select: { id: true, domain: true, platform: true, status: true, uninstalledAt: true },
        });
        if (!currentShop || currentShop.domain !== integrationDomain || currentShop.platform !== "SHOPIFY") {
          throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
        }

        const offlineRows = await transaction.session.findMany({
          where: { shop: currentShop.domain, isOnline: false },
          select: { id: true, shop: true, isOnline: true },
          take: 2,
        });
        if (offlineRows.length > 1) throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");

        let sessionId: string | null = offlineRows[0]?.id ?? null;
        if (options.sessionId) {
          const selected = await transaction.session.findUnique({
            where: { id: options.sessionId },
            select: { id: true, shop: true, isOnline: true },
          });
          if (!selected || selected.shop !== currentShop.domain) {
            throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
          }
          if (!selected.isOnline && offlineRows[0]?.id !== selected.id) {
            throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
          }
          sessionId = selected.id;
        }
        if (sessionId) {
          await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "shopify"."Session" WHERE "id" = ${sessionId} FOR UPDATE`);
        }
        return work({ transaction, shop: currentShop, sessionId });
      });
    },
  });
}

export const shopifyOfflineCoordination = createCoordinatedShopifyAuthentication();

export { ShopifyOfflineTokenError };
