import Redis from "ioredis";
import { Client } from "pg";

/**
 * Operational health/readiness checks for the Shopify application service.
 *
 * These checks are intentionally lightweight and non-mutating:
 * - `/health` (process liveness) performs no dependency calls.
 * - `/ready` (dependency readiness) performs bounded PING/SELECT checks and
 *   returns only booleans. Check responses never include connection strings,
 *   credentials or raw error text.
 */

export const HEALTH_CHECK_TIMEOUT_MS = 1500;

export type ReadinessChecks = {
  redis: boolean;
  postgres: boolean;
};

export type ReadinessResult = {
  status: "ready" | "not_ready";
  checks: ReadinessChecks;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Health check timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}

/**
 * Verifies Redis connectivity with a bounded, non-mutating PING.
 *
 * A short-lived connection is created per check so that a stuck or slow Redis
 * endpoint cannot pin an idle connection open between polls. `retryStrategy`
 * is disabled so a failed connection rejects promptly instead of retrying.
 */
export async function checkRedisReadiness(
  redisUrl: string | undefined,
): Promise<boolean> {
  if (!redisUrl) {
    return false;
  }

  const client = new Redis(redisUrl, {
    connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: () => null,
  });

  // Connection failures surface through the connect()/ping() outcome below.
  // Without a listener, an ioredis 'error' event would crash the process.
  client.on("error", () => {});

  try {
    await withTimeout(client.connect(), HEALTH_CHECK_TIMEOUT_MS);
    await withTimeout(client.ping(), HEALTH_CHECK_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

/**
 * Purpose-built PostgreSQL probe.
 *
 * Connection acquisition and query execution are bounded by pg driver
 * configuration:
 *
 * - `connectionTimeoutMillis` bounds connection/handshake acquisition;
 * - `query_timeout` aborts a `SELECT 1` that does not answer in time
 *   (client side);
 * - `statement_timeout` makes PostgreSQL cancel the statement server-side.
 *
 * The short-lived probe always invokes `end()` in `finally` so the application
 * does not intentionally retain the readiness client after success or failure.
 */
export type PostgresProbe = {
  /**
   * Acquires the connection. `pg` resolves with the client itself, but the
   * return value is intentionally not part of the probe contract.
   */
  connect(): Promise<unknown>;
  query(statement: string): Promise<unknown>;
  end(): Promise<void>;
};

export type PostgresProbeFactory = (
  connectionString: string,
) => PostgresProbe;

export function createPostgresProbe(connectionString: string): PostgresProbe {
  return new Client({
    connectionString,
    connectionTimeoutMillis: HEALTH_CHECK_TIMEOUT_MS,
    query_timeout: HEALTH_CHECK_TIMEOUT_MS,
    statement_timeout: HEALTH_CHECK_TIMEOUT_MS,
  });
}

/**
 * Verifies PostgreSQL connectivity with a bounded, non-mutating `SELECT 1`.
 *
 * Connection acquisition and query execution are bounded by pg driver
 * configuration (see `createPostgresProbe`). The short-lived probe always
 * invokes `end()` in `finally`, so the application does not intentionally
 * retain the readiness client after success or failure.
 */
export async function checkPostgresReadiness(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  createProbe: PostgresProbeFactory = createPostgresProbe,
): Promise<boolean> {
  if (!databaseUrl) {
    return false;
  }

  const probe = createProbe(databaseUrl);

  try {
    await probe.connect();
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    // Always release the probe connection. Teardown errors are swallowed so
    // they cannot mask the readiness result.
    await probe.end().catch(() => {});
  }
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const [redis, postgres] = await Promise.all([
    checkRedisReadiness(process.env.REDIS_URL),
    checkPostgresReadiness(),
  ]);

  return {
    status: redis && postgres ? "ready" : "not_ready",
    checks: { redis, postgres },
  };
}
