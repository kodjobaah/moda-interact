import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockRedisClient = {
  connect: unknown;
  ping: unknown;
  disconnect: unknown;
  on: unknown;
};

const mockRedisClients: unknown[] = [];

const mockRedisBehaviour = {
  connectError: null as Error | null,
  connectHangs: false,
};

vi.mock("ioredis", () => {
  class MockRedis {
    connect = vi.fn().mockImplementation(() => {
      if (mockRedisBehaviour.connectHangs) {
        return new Promise(() => {});
      }
      if (mockRedisBehaviour.connectError) {
        return Promise.reject(mockRedisBehaviour.connectError);
      }
      return Promise.resolve();
    });
    ping = vi.fn().mockResolvedValue("PONG");
    disconnect = vi.fn();
    on = vi.fn();

    constructor() {
      mockRedisClients.push(this);
    }
  }

  return { default: MockRedis };
});

type MockPgClient = {
  options: unknown;
  connect: unknown;
  query: unknown;
  end: unknown;
};

const mockPgClients: MockPgClient[] = [];

const mockPgBehaviour = {
  connectError: null as Error | null,
  queryError: null as Error | null,
  // When > 0, `query` rejects with a driver-style timeout error after this
  // many ms, simulating `pg`'s `query_timeout` firing on a hung statement.
  queryTimeoutMs: 0 as number,
};

vi.mock("pg", () => {
  class MockPgClient {
    options: unknown;

    connect = vi.fn().mockImplementation(() => {
      if (mockPgBehaviour.connectError) {
        return Promise.reject(mockPgBehaviour.connectError);
      }
      return Promise.resolve();
    });
    query = vi.fn().mockImplementation(() => {
      if (mockPgBehaviour.queryTimeoutMs > 0) {
        return new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error("timeout exceeded when waiting for query result"),
              ),
            mockPgBehaviour.queryTimeoutMs,
          ),
        );
      }
      if (mockPgBehaviour.queryError) {
        return Promise.reject(mockPgBehaviour.queryError);
      }
      return Promise.resolve({ rows: [{ "?column?": 1 }] });
    });
    end = vi.fn().mockResolvedValue(undefined);

    constructor(options: unknown) {
      this.options = options;
      mockPgClients.push(this);
    }
  }

  return { Client: MockPgClient };
});

const {
  checkPostgresReadiness,
  checkReadiness,
  checkRedisReadiness,
  HEALTH_CHECK_TIMEOUT_MS,
} = await import("../../../app/services/health/health-check.server");

function lastRedisClient(): MockRedisClient {
  return mockRedisClients[mockRedisClients.length - 1] as MockRedisClient;
}

function lastPgClient(): MockPgClient {
  return mockPgClients[mockPgClients.length - 1] as MockPgClient;
}

beforeEach(() => {
  mockRedisClients.length = 0;
  mockPgClients.length = 0;
  mockRedisBehaviour.connectError = null;
  mockRedisBehaviour.connectHangs = false;
  mockPgBehaviour.connectError = null;
  mockPgBehaviour.queryError = null;
  mockPgBehaviour.queryTimeoutMs = 0;
  vi.clearAllMocks();
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.DATABASE_URL =
    "postgresql://app:app@localhost:5432/moda_interact";
});

afterEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.DATABASE_URL;
});

describe("checkRedisReadiness", () => {
  it("returns true when Redis answers a bounded PING", async () => {
    await expect(
      checkRedisReadiness("redis://localhost:6379"),
    ).resolves.toBe(true);

    expect(mockRedisClients).toHaveLength(1);
    expect(lastRedisClient().ping).toHaveBeenCalledTimes(1);
    expect(lastRedisClient().disconnect).toHaveBeenCalled();
    expect(lastRedisClient().on).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });

  it("returns false when REDIS_URL is not configured", async () => {
    await expect(checkRedisReadiness(undefined)).resolves.toBe(false);

    expect(mockRedisClients).toHaveLength(0);
  });

  it("returns false when Redis cannot be reached", async () => {
    mockRedisBehaviour.connectError = new Error("ECONNREFUSED 127.0.0.1:6379");

    await expect(
      checkRedisReadiness("redis://localhost:6379"),
    ).resolves.toBe(false);
  });

  it("is bounded when Redis never responds", async () => {
    mockRedisBehaviour.connectHangs = true;

    const startedAt = Date.now();
    await expect(
      checkRedisReadiness("redis://localhost:6379"),
    ).resolves.toBe(false);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(HEALTH_CHECK_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(HEALTH_CHECK_TIMEOUT_MS + 1500);
  });

  it("creates a fresh bounded connection per check instead of a persistent one", async () => {
    await checkRedisReadiness("redis://localhost:6379");
    await checkRedisReadiness("redis://localhost:6379");

    expect(mockRedisClients).toHaveLength(2);
    expect(mockRedisClients[0]).not.toBe(mockRedisClients[1]);
  });
});

describe("checkPostgresReadiness", () => {
  it("returns true when the database answers", async () => {
    await expect(checkPostgresReadiness()).resolves.toBe(true);

    expect(mockPgClients).toHaveLength(1);
    expect(lastPgClient().connect).toHaveBeenCalledTimes(1);
    expect(lastPgClient().query).toHaveBeenCalledWith("SELECT 1");
    // The probe connection is released on the success path too.
    expect(lastPgClient().end).toHaveBeenCalledTimes(1);
  });

  it("returns false when DATABASE_URL is not configured", async () => {
    delete process.env.DATABASE_URL;

    await expect(checkPostgresReadiness()).resolves.toBe(false);

    expect(mockPgClients).toHaveLength(0);
  });

  it("returns false when the database cannot be reached", async () => {
    mockPgBehaviour.connectError = new Error("ECONNREFUSED 127.0.0.1:5432");

    await expect(checkPostgresReadiness()).resolves.toBe(false);

    // The probe connection is released even when acquisition fails.
    expect(lastPgClient().end).toHaveBeenCalledTimes(1);
  });

  it("returns false when the query fails", async () => {
    mockPgBehaviour.queryError = new Error(
      "canceling statement due to user request",
    );

    await expect(checkPostgresReadiness()).resolves.toBe(false);

    // The probe connection is released even when the query fails.
    expect(lastPgClient().end).toHaveBeenCalledTimes(1);
  });

  it("returns false and releases the probe when the driver query timeout fires", async () => {
    // Simulates `pg`'s `query_timeout`: the driver rejects the pending query
    // instead of leaving it running. The probe must settle and release the
    // connection, so a timed-out probe cannot accumulate in the background.
    mockPgBehaviour.queryTimeoutMs = 30;

    await expect(checkPostgresReadiness()).resolves.toBe(false);

    expect(lastPgClient().query).toHaveBeenCalledWith("SELECT 1");
    expect(lastPgClient().end).toHaveBeenCalledTimes(1);
  });

  it("bounds connection acquisition, query execution and teardown at the driver level", async () => {
    await checkPostgresReadiness(
      "postgresql://probe:probe@127.0.0.1:5432/probe",
    );

    expect(lastPgClient().options).toMatchObject({
      connectionTimeoutMillis: HEALTH_CHECK_TIMEOUT_MS,
      query_timeout: HEALTH_CHECK_TIMEOUT_MS,
      statement_timeout: HEALTH_CHECK_TIMEOUT_MS,
    });
  });
});

describe("checkPostgresReadiness probe lifecycle (factory contract)", () => {
  const probeUrl = "postgresql://probe:probe@127.0.0.1:5432/probe";

  function createProbeSpy() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
      end: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("calls end() on the probe after a successful check", async () => {
    const probe = createProbeSpy();

    await expect(
      checkPostgresReadiness(probeUrl, () => probe),
    ).resolves.toBe(true);

    expect(probe.connect).toHaveBeenCalledTimes(1);
    expect(probe.query).toHaveBeenCalledWith("SELECT 1");
    expect(probe.end).toHaveBeenCalledTimes(1);
  });

  it("calls end() when connection acquisition fails", async () => {
    const probe = createProbeSpy();
    probe.connect.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:5432"));

    await expect(
      checkPostgresReadiness(probeUrl, () => probe),
    ).resolves.toBe(false);

    expect(probe.end).toHaveBeenCalledTimes(1);
  });

  it("calls end() when the query fails", async () => {
    const probe = createProbeSpy();
    probe.query.mockRejectedValue(
      new Error("canceling statement due to user request"),
    );

    await expect(
      checkPostgresReadiness(probeUrl, () => probe),
    ).resolves.toBe(false);

    expect(probe.end).toHaveBeenCalledTimes(1);
  });

  it("calls end() when the driver query timeout fires", async () => {
    const probe = createProbeSpy();
    probe.query.mockRejectedValue(
      new Error("timeout exceeded when waiting for query result"),
    );

    await expect(
      checkPostgresReadiness(probeUrl, () => probe),
    ).resolves.toBe(false);

    expect(probe.end).toHaveBeenCalledTimes(1);
  });

  it("swallows end() teardown errors so they cannot mask the result", async () => {
    const probe = createProbeSpy();
    probe.connect.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:5432"));
    probe.end.mockRejectedValue(new Error("connection already closed"));

    await expect(
      checkPostgresReadiness(probeUrl, () => probe),
    ).resolves.toBe(false);

    expect(probe.end).toHaveBeenCalledTimes(1);
  });
});

describe("checkReadiness", () => {
  it("reports ready only when every required dependency is ready", async () => {
    await expect(checkReadiness()).resolves.toEqual({
      status: "ready",
      checks: { redis: true, postgres: true },
    });
  });

  it("reports not_ready when Redis is unavailable", async () => {
    mockRedisBehaviour.connectError = new Error("ECONNREFUSED");

    await expect(checkReadiness()).resolves.toEqual({
      status: "not_ready",
      checks: { redis: false, postgres: true },
    });
  });

  it("reports not_ready when PostgreSQL is unavailable", async () => {
    mockPgBehaviour.connectError = new Error("ECONNREFUSED");

    await expect(checkReadiness()).resolves.toEqual({
      status: "not_ready",
      checks: { redis: true, postgres: false },
    });
  });

  it("never surfaces raw error text (credentials, hosts or URLs)", async () => {
    mockPgBehaviour.connectError = new Error(
      "password authentication failed for user root@db.internal",
    );
    mockRedisBehaviour.connectError = new Error(
      "AUTH failed redis://secret@redis.internal:6379",
    );

    const result = await checkReadiness();

    expect(JSON.stringify(result)).not.toMatch(
      /(password|secret|root@|redis:\/\/|internal|auth)/i,
    );
  });
});
